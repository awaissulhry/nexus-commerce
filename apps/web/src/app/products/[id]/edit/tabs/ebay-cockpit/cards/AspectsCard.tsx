'use client'

// EC.5 — AspectsCard
//
// Dynamic Field-Source-aware editor for eBay item aspects. Pulls
// the schema for the currently-picked category via the existing
// /api/ebay/flat-file/category-schema endpoint (read-only call, no
// changes to flat-file routes) and renders one row per aspect using
// the EC.2 FieldSourceRow primitive.
//
// Groups (in render order):
//   1. Required             — red rim; must be filled before publish
//   2. Recommended          — amber rim; eBay search-rank uplift
//   3. Variation-eligible   — purple rim; tied to product variants
//                              (EC.6's Variation Matrix wires these
//                              per-cell; here we just expose the
//                              parent-level value)
//   4. Optional             — slate rim; informational
//
// Persistence: edits are buffered locally and saved via Save All
// (uses the existing fetch wiring; doesn't depend on DSP registry
// since aspects PATCH is atomic per-row). EC.10 hoists everything
// to the DSP-series flush registry.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, AlertCircle, Save, CheckCircle2, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useRouter } from 'next/navigation'
import { useTranslations } from '@/lib/i18n/use-translations'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'
import FieldSourceRow from '../field-source/FieldSourceRow'
import type { FieldSource } from '../field-source/types'
import { resolveMasterValue } from './aspect-master-map'
import AiImproveModal from '../ai/AiImproveModal'

interface SchemaAspect {
  id: string
  label: string
  kind: 'enum' | 'number' | 'text'
  options?: string[]
  required: boolean
  recommended: boolean
  guidance: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'
  width: number
  variantEligible: boolean
}

interface SchemaResponse {
  categoryId: string
  marketplace: string
  aspects: SchemaAspect[]
}

interface SiblingItemSpecifics {
  marketplace: string
  itemSpecifics: Record<string, string[]>
}

interface Props {
  productId: string
  marketplace: string
  categoryId: string | null
  /** Initial item specifics from the listing's platformAttributes.
   *  Single strings or string[] both accepted; AspectsCard normalises. */
  initialItemSpecifics: Record<string, string | string[]>
  /** Used by the "From Master" source resolver. */
  master: {
    brand: string | null
    color: string | null
    size: string | null
    material: string | null
    gender: string | null
    productType: string | null
    weightG: number | null
    countryOfOrigin: string | null
    mpn: string | null
    gtin: string | null
    ean: string | null
    upc: string | null
  }
  /** Used by the "From Sibling" source resolver. */
  siblings: SiblingItemSpecifics[]
}

// Aspect-name → aspect.label rendering. eBay's schema endpoint
// returns labels like "Marca (Brand)"; we strip the parenthesised
// English so the row label stays short. The full name is preserved
// in `aspect.label` for tooltips.
function shortLabel(label: string): string {
  return label.split(' (')[0] ?? label
}

function firstValue(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? ''
  return v ?? ''
}

export default function AspectsCard({
  productId,
  marketplace,
  categoryId,
  initialItemSpecifics,
  master,
  siblings,
}: Props) {
  const router = useRouter()
  const { t } = useTranslations()
  const [schema, setSchema] = useState<SchemaResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)
  const [dirtyValues, setDirtyValues] = useState<Record<string, string>>({})
  const [aiOpen, setAiOpen] = useState(false)

  const initialFlat = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(initialItemSpecifics)) {
      out[k] = firstValue(v)
    }
    return out
  }, [initialItemSpecifics])

  // Fetch schema whenever categoryId changes.
  useEffect(() => {
    if (!categoryId) {
      setSchema(null)
      return
    }
    let aborted = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const u = new URL(`${getBackendUrl()}/api/ebay/flat-file/category-schema`)
        u.searchParams.set('categoryId', categoryId)
        u.searchParams.set('marketplace', `EBAY_${marketplace.toUpperCase()}`)
        const res = await fetch(u.toString())
        const json = await res.json()
        if (aborted) return
        if (!res.ok) {
          setError(json?.error ?? `HTTP ${res.status}`)
          setSchema(null)
        } else {
          setSchema(json as SchemaResponse)
        }
      } catch (err) {
        if (!aborted) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!aborted) setLoading(false)
      }
    })()
    return () => {
      aborted = true
    }
  }, [categoryId, marketplace])

  // Group aspects: Required → Recommended → Variation-eligible →
  // Optional. Variation-eligible aspects are EXCLUDED from
  // Optional/Recommended once they're surfaced in the Variation
  // group, so each aspect appears in exactly one bucket.
  const grouped = useMemo(() => {
    const required: SchemaAspect[] = []
    const recommended: SchemaAspect[] = []
    const variation: SchemaAspect[] = []
    const optional: SchemaAspect[] = []
    for (const a of schema?.aspects ?? []) {
      if (a.required || a.guidance === 'REQUIRED') {
        required.push(a)
      } else if (a.variantEligible) {
        variation.push(a)
      } else if (a.recommended || a.guidance === 'RECOMMENDED') {
        recommended.push(a)
      } else {
        optional.push(a)
      }
    }
    return { required, recommended, variation, optional }
  }, [schema])

  const dirtyCount = Object.keys(dirtyValues).length

  // Pre-publish health: required-but-empty count.
  const requiredMissing = useMemo(() => {
    return grouped.required.filter((a) => {
      const current = dirtyValues[a.id] ?? initialFlat[a.id]
      return !current || current.trim().length === 0
    }).length
  }, [grouped.required, dirtyValues, initialFlat])

  const handleSaveAll = useCallback(async () => {
    if (saving || dirtyCount === 0) return
    setSaving(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/aspects`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId,
          marketplace,
          // EC.5 keeps single-value for substrate; multi-value tag
          // input (EC.5b) splits comma-separated entries into arrays.
          aspects: dirtyValues,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setDirtyValues({})
      setSavedFlash(true)
      window.setTimeout(() => setSavedFlash(false), 1500)
      // Refresh server payload so initialFlat re-seeds from saved state
      // and the cockpit reflects the new aspects everywhere (health
      // score will pick this up in EC.9 when it lands).
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, dirtyCount, dirtyValues, productId, marketplace, router])

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-subtle dark:border-slate-800 flex items-center gap-2">
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          {t('products.edit.cockpit.ebay.aspects.title')}
        </div>
        <Badge variant="info">EC.5</Badge>
        {schema && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {schema.aspects.length} {t('products.edit.cockpit.ebay.aspects.forCategory')} {schema.categoryId}
          </span>
        )}
        {requiredMissing > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 ml-auto">
            <AlertCircle className="w-3 h-3" /> {requiredMissing} {t('products.edit.cockpit.ebay.aspects.requiredMissing')}
          </span>
        )}
        {requiredMissing === 0 && schema && grouped.required.length > 0 && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10.5px] font-medium bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 ml-auto">
            <CheckCircle2 className="w-3 h-3" /> {t('products.edit.cockpit.ebay.aspects.requiredComplete')}
          </span>
        )}
        {schema && (
          <button
            type="button"
            onClick={() => setAiOpen(true)}
            className={cn(
              'inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded border border-amber-200 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 hover:bg-amber-100',
              !(requiredMissing > 0 || schema.aspects.length > Object.keys(initialFlat).length) && 'ml-auto',
            )}
            title={t('products.edit.cockpit.ebay.aspects.aiSuggestTooltip')}
          >
            <Sparkles className="w-3 h-3" /> {t('products.edit.cockpit.ebay.aspects.aiSuggest')}
          </button>
        )}
      </div>

      <div className="p-4 space-y-4">
        {!categoryId && (
          <div className="text-xs text-slate-500 dark:text-slate-400 italic">
            {t('products.edit.cockpit.ebay.aspects.pickCategoryHint')}
          </div>
        )}
        {categoryId && loading && (
          <div className="text-xs text-slate-500 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> {t('products.edit.cockpit.ebay.aspects.loadingSchema')} {categoryId}…
          </div>
        )}
        {categoryId && error && (
          <div className="text-xs px-3 py-2 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
            {error}
          </div>
        )}
        {schema && !loading && (
          <>
            <AspectGroup
              kind="required"
              title={t('products.edit.cockpit.ebay.aspects.groupRequiredTitle')}
              hint={t('products.edit.cockpit.ebay.aspects.groupRequiredHint')}
              aspects={grouped.required}
              currentValue={(id) => dirtyValues[id] ?? initialFlat[id] ?? ''}
              initialValue={(id) => initialFlat[id] ?? ''}
              onChange={(id, v) => setDirtyValues((d) => ({ ...d, [id]: v }))}
              marketplace={marketplace}
              master={master}
              siblings={siblings}
            />
            <AspectGroup
              kind="recommended"
              title={t('products.edit.cockpit.ebay.aspects.groupRecommendedTitle')}
              hint={t('products.edit.cockpit.ebay.aspects.groupRecommendedHint')}
              aspects={grouped.recommended}
              currentValue={(id) => dirtyValues[id] ?? initialFlat[id] ?? ''}
              initialValue={(id) => initialFlat[id] ?? ''}
              onChange={(id, v) => setDirtyValues((d) => ({ ...d, [id]: v }))}
              marketplace={marketplace}
              master={master}
              siblings={siblings}
            />
            <AspectGroup
              kind="variation"
              title={t('products.edit.cockpit.ebay.aspects.groupVariationTitle')}
              hint={t('products.edit.cockpit.ebay.aspects.groupVariationHint')}
              aspects={grouped.variation}
              currentValue={(id) => dirtyValues[id] ?? initialFlat[id] ?? ''}
              initialValue={(id) => initialFlat[id] ?? ''}
              onChange={(id, v) => setDirtyValues((d) => ({ ...d, [id]: v }))}
              marketplace={marketplace}
              master={master}
              siblings={siblings}
            />
            <AspectGroup
              kind="optional"
              title={t('products.edit.cockpit.ebay.aspects.groupOptionalTitle')}
              hint={t('products.edit.cockpit.ebay.aspects.groupOptionalHint')}
              aspects={grouped.optional}
              currentValue={(id) => dirtyValues[id] ?? initialFlat[id] ?? ''}
              initialValue={(id) => initialFlat[id] ?? ''}
              onChange={(id, v) => setDirtyValues((d) => ({ ...d, [id]: v }))}
              marketplace={marketplace}
              master={master}
              siblings={siblings}
            />
          </>
        )}
      </div>

      {schema && (
        <div className="px-4 py-2.5 border-t border-subtle dark:border-slate-800 flex items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {dirtyCount === 0
              ? t('products.edit.cockpit.ebay.aspects.allSaved')
              : `${dirtyCount} ${dirtyCount === 1 ? t('products.edit.cockpit.ebay.aspects.unsavedAspectOne') : t('products.edit.cockpit.ebay.aspects.unsavedAspectMany')}`}
          </span>
          {savedFlash && (
            <span className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1">
              <CheckCircle2 className="w-3.5 h-3.5" /> {t('products.edit.cockpit.ebay.aspects.saved')}
            </span>
          )}
          <button
            type="button"
            onClick={handleSaveAll}
            disabled={saving || dirtyCount === 0}
            className="ml-auto px-3 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saving ? t('products.edit.cockpit.ebay.aspects.saving') : t('products.edit.cockpit.ebay.aspects.saveAspects')}
          </button>
        </div>
      )}

      <AiImproveModal
        open={aiOpen}
        operation="aspects"
        productId={productId}
        marketplace={marketplace}
        currentAspects={(() => {
          const out: Record<string, string> = {}
          for (const [k, v] of Object.entries(initialFlat)) out[k] = v
          for (const [k, v] of Object.entries(dirtyValues)) out[k] = v
          return out
        })()}
        onApplyAspects={(next) => {
          // Merge AI-suggested values into the dirty buffer so the
          // operator can review / edit before hitting Save aspects.
          setDirtyValues((d) => ({ ...d, ...next }))
        }}
        onClose={() => setAiOpen(false)}
      />
    </Card>
  )
}

// ── AspectGroup ────────────────────────────────────────────────────────
const GROUP_TONES = {
  required:    { rim: 'border-rose-200 dark:border-rose-800',     dot: 'bg-rose-500',    chip: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300' },
  recommended: { rim: 'border-amber-200 dark:border-amber-800',   dot: 'bg-amber-500',   chip: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300' },
  variation:   { rim: 'border-violet-200 dark:border-violet-800', dot: 'bg-violet-500',  chip: 'bg-violet-50 dark:bg-violet-950/40 text-violet-700 dark:text-violet-300' },
  optional:    { rim: 'border-default dark:border-slate-700',   dot: 'bg-slate-400',   chip: 'bg-slate-50 dark:bg-slate-800 text-slate-600 dark:text-slate-400' },
} as const

function AspectGroup({
  kind, title, hint, aspects, currentValue, initialValue, onChange, marketplace, master, siblings,
}: {
  kind: keyof typeof GROUP_TONES
  title: string
  hint: string
  aspects: SchemaAspect[]
  currentValue: (id: string) => string
  initialValue: (id: string) => string
  onChange: (id: string, v: string) => void
  marketplace: string
  master: Props['master']
  siblings: SiblingItemSpecifics[]
}) {
  if (aspects.length === 0) return null
  const tone = GROUP_TONES[kind]
  return (
    <div className={cn('rounded-lg border-l-4 pl-3', tone.rim)}>
      <div className="flex items-center gap-2 mb-2">
        <span className={cn('inline-block w-1.5 h-1.5 rounded-full', tone.dot)} />
        <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">{title}</div>
        <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', tone.chip)}>
          {aspects.length}
        </span>
        <span className="text-[10.5px] text-slate-500 dark:text-slate-400 italic">{hint}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-3">
        {aspects.map((a) => (
          <AspectFieldRow
            key={a.id}
            aspect={a}
            marketplace={marketplace}
            initialValue={initialValue(a.id)}
            currentValue={currentValue(a.id)}
            onChange={(v) => onChange(a.id, v)}
            master={master}
            siblings={siblings}
          />
        ))}
      </div>
    </div>
  )
}

// ── Single aspect row ──────────────────────────────────────────────────
function AspectFieldRow({
  aspect, marketplace, initialValue, currentValue, onChange, master, siblings,
}: {
  aspect: SchemaAspect
  marketplace: string
  initialValue: string
  currentValue: string
  onChange: (v: string) => void
  master: Props['master']
  siblings: SiblingItemSpecifics[]
}) {
  // Aspect name lives at the end of "Marca (Brand)" — strip the
  // parenthesised English so the master resolver matches the
  // localised name AND so the label stays short.
  const localName = aspect.label.split(' (')[0]?.trim() ?? aspect.label

  const masterValue = useMemo(() => resolveMasterValue(localName, master), [localName, master])
  const siblingValue = useMemo(() => {
    for (const s of siblings) {
      const v = s.itemSpecifics?.[aspect.id]
      if (Array.isArray(v) && v.length > 0) return v[0]
    }
    return null
  }, [siblings, aspect.id])

  const availableSources: FieldSource[] = useMemo(() => {
    const src: FieldSource[] = ['manual']
    if (masterValue != null) src.push('master')
    if (siblingValue != null) src.push('sibling')
    src.push('default')
    return src
  }, [masterValue, siblingValue])

  return (
    <FieldSourceRow
      fieldKey={`${marketplace}.aspect.${aspect.id}`}
      label={shortLabel(aspect.label)}
      initial={{
        source: initialValue ? 'manual' : 'default',
        value: initialValue,
      }}
      availableSources={availableSources}
      resolveValue={(src) => {
        if (src === 'master')  return masterValue
        if (src === 'sibling') return siblingValue
        if (src === 'default') return ''
        return null
      }}
      preview={(src) => {
        if (src === 'master')  return masterValue
        if (src === 'sibling') return siblingValue
        return null
      }}
    >
      {({ value, onChange: setLocalValue }) => {
        // FieldSourceRow owns the value buffer (via useFieldSource).
        // The AspectsCard needs the same value in its dirtyValues map
        // for Save All — bridge with a small reconciler effect.
        return (
          <AspectInput
            aspect={aspect}
            value={value}
            onChange={(next) => {
              setLocalValue(next)
              if (next !== currentValue) onChange(next)
            }}
          />
        )
      }}
    </FieldSourceRow>
  )
}

function AspectInput({
  aspect, value, onChange,
}: { aspect: SchemaAspect; value: string; onChange: (v: string) => void }) {
  const { t } = useTranslations()
  if (aspect.kind === 'enum' && aspect.options && aspect.options.length > 0) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
      >
        <option value="">{t('products.edit.cockpit.ebay.aspects.pickOption')}</option>
        {aspect.options.map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    )
  }
  if (aspect.kind === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
      />
    )
  }
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={aspect.required ? t('products.edit.cockpit.ebay.aspects.requiredPlaceholder') : ''}
      className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1 bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
    />
  )
}
