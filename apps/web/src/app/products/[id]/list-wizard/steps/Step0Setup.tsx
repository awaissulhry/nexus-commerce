// TT — Setup pre-step. Shown only in create-flow (currentStep=0).
// Captures: parent vs variant, master SKU, master name, base price.
// On Continue, PATCHes the master Product row and advances the
// wizard to Step 1 (Channels). Existing wizards never see this
// step because their currentStep starts at 1.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2, Package, Layers, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import type { StepProps } from '../ListWizardClient'

interface ParentSearchHit {
  id: string
  sku: string
  name: string
}

export default function Step0Setup({
  product,
  updateWizardState,
}: StepProps) {
  // Mode toggle: parent (the master, can later acquire variants in
  // Step 4) vs variant (links to an existing parent SKU now).
  const [mode, setMode] = useState<'parent' | 'variant'>('parent')
  const [sku, setSku] = useState(product.sku ?? '')
  const [name, setName] = useState(
    // Strip the auto-generated "Untitled product" placeholder so the
    // user gets a clean input rather than a hint sitting in the
    // field. They can still see what was there via the placeholder.
    product.name === 'Untitled product' ? '' : product.name ?? '',
  )
  const [basePrice, setBasePrice] = useState('0')
  const [parentSearch, setParentSearch] = useState('')
  const [parentResults, setParentResults] = useState<ParentSearchHit[]>([])
  const [parentSearchLoading, setParentSearchLoading] = useState(false)
  const [selectedParent, setSelectedParent] = useState<ParentSearchHit | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Validate. Continue is enabled when: SKU present, name present,
  // basePrice >= 0. Variant mode also requires a selected parent.
  const valid = useMemo(() => {
    const priceNum = Number(basePrice)
    if (!sku.trim() || !name.trim()) return false
    if (!Number.isFinite(priceNum) || priceNum < 0) return false
    if (mode === 'variant' && !selectedParent) return false
    return true
  }, [sku, name, basePrice, mode, selectedParent])

  // Debounced parent search — only fires in variant mode.
  const lastSearchRef = useRef('')
  useEffect(() => {
    if (mode !== 'variant') {
      setParentResults([])
      return
    }
    const term = parentSearch.trim()
    if (term.length < 2) {
      setParentResults([])
      return
    }
    lastSearchRef.current = term
    const t = window.setTimeout(async () => {
      setParentSearchLoading(true)
      try {
        const url = new URL(`${getBackendUrl()}/api/products/bulk-fetch`)
        url.searchParams.set('search', term)
        url.searchParams.set('limit', '10')
        const res = await fetch(url.toString())
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (lastSearchRef.current !== term) return
        const candidates: ParentSearchHit[] = (json?.products ?? [])
          .filter((p: { isParent?: boolean; id?: string }) => p.isParent && p.id)
          .map((p: { id: string; sku: string; name: string }) => ({
            id: p.id,
            sku: p.sku,
            name: p.name,
          }))
        setParentResults(candidates)
      } catch (err) {
        console.warn(
          '[Step0Setup] parent search failed',
          err instanceof Error ? err.message : err,
        )
        setParentResults([])
      } finally {
        setParentSearchLoading(false)
      }
    }, 250)
    return () => window.clearTimeout(t)
  }, [parentSearch, mode])

  const handleContinue = async () => {
    if (!valid) return
    setSaving(true)
    setError(null)
    try {
      // Persist master fields directly on the Product row via the
      // existing bulk-PATCH endpoint. The wizard's wizardState lives
      // on the wizard row, not the product, so PATCHing the product
      // is the right shape here.
      const changes = [
        { id: product.id, field: 'sku', value: sku.trim() },
        { id: product.id, field: 'name', value: name.trim() },
        { id: product.id, field: 'basePrice', value: Number(basePrice) },
        {
          id: product.id,
          field: 'isParent',
          value: mode === 'parent',
        },
      ]
      if (mode === 'variant' && selectedParent) {
        changes.push({
          id: product.id,
          field: 'parentId',
          value: selectedParent.id,
        })
      }
      const res = await fetch(`${getBackendUrl()}/api/products/bulk`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.success === false) {
        const detailedError =
          json?.errors?.[0]?.error ??
          json?.error ??
          `Couldn't save setup (HTTP ${res.status}).`
        setError(detailedError)
        return
      }
      // Advance to Step 1 (Channels). updateWizardState handles the
      // PATCH against the wizard row.
      await updateWizardState({}, { advance: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-10 px-6">
      <div className="mb-6">
        <h2 className="text-[20px] font-semibold text-slate-900">Setup</h2>
        <p className="text-[13px] text-slate-600 mt-1">
          Set the master fields for this product. You'll handle channels,
          categories, attributes, pricing per market and submit through the
          rest of the wizard.
        </p>
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-3 mb-5">
        <ModeCard
          icon={Package}
          title="Parent product"
          subtitle="Standalone or has variants (size, colour, …). You pick the variation theme in Step 4."
          active={mode === 'parent'}
          onClick={() => setMode('parent')}
        />
        <ModeCard
          icon={Layers}
          title="Variant of an existing parent"
          subtitle="Links this SKU under an existing parent. The parent's attributes flow down."
          active={mode === 'variant'}
          onClick={() => setMode('variant')}
        />
      </div>

      {mode === 'variant' && (
        <div className="mb-5 border border-slate-200 rounded-lg bg-white">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={parentSearch}
              onChange={(e) => setParentSearch(e.target.value)}
              placeholder="Search parent by SKU or name (min 2 chars)"
              className="flex-1 h-7 text-[12px] focus:outline-none bg-transparent"
            />
            {parentSearchLoading && (
              <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
            )}
          </div>
          <div className="max-h-[180px] overflow-y-auto">
            {selectedParent && (
              <div className="px-3 py-2 bg-blue-50 border-b border-blue-100 text-[12px] flex items-center justify-between">
                <span>
                  <span className="font-mono">{selectedParent.sku}</span>{' '}
                  <span className="text-slate-600">— {selectedParent.name}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setSelectedParent(null)}
                  className="text-blue-700 hover:underline text-[11px]"
                >
                  Change
                </button>
              </div>
            )}
            {!selectedParent && parentResults.length === 0 && parentSearch.trim().length >= 2 && !parentSearchLoading && (
              <div className="px-3 py-3 text-[12px] text-slate-500 text-center">
                No parent products match.
              </div>
            )}
            {!selectedParent &&
              parentResults.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedParent(p)}
                  className="w-full text-left px-3 py-2 text-[12px] hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                >
                  <div className="font-mono text-slate-900">{p.sku}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {p.name}
                  </div>
                </button>
              ))}
          </div>
        </div>
      )}

      {/* Master fields */}
      <div className="space-y-3 mb-5">
        <Field label="Master SKU" required>
          <input
            type="text"
            value={sku}
            onChange={(e) => setSku(e.target.value)}
            placeholder="XAV-OUTERWEAR-001"
            className={inputCls}
          />
        </Field>
        <Field label="Product name" required>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Xavia Storm Adventure Jacket"
            className={inputCls}
          />
        </Field>
        <Field
          label="Base price"
          required
          hint="Per-marketplace overrides happen in Step 7"
        >
          <input
            type="number"
            min="0"
            step="0.01"
            value={basePrice}
            onChange={(e) => setBasePrice(e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 border border-rose-200 bg-rose-50 rounded-md text-[12px] text-rose-700 inline-flex items-start gap-2 max-w-full">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span className="break-words">{error}</span>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        <button
          type="button"
          onClick={handleContinue}
          disabled={!valid || saving}
          className={cn(
            'h-8 px-4 rounded-md text-[13px] font-medium transition-colors inline-flex items-center gap-1.5',
            !valid || saving
              ? 'bg-slate-100 text-slate-400 cursor-not-allowed'
              : 'bg-blue-600 text-white hover:bg-blue-700',
          )}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Continue
        </button>
      </div>
    </div>
  )
}

function ModeCard({
  icon: Icon,
  title,
  subtitle,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  subtitle: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'text-left border rounded-lg p-3 transition-colors',
        active
          ? 'border-blue-300 bg-blue-50'
          : 'border-slate-200 bg-white hover:border-slate-300',
      )}
    >
      <Icon
        className={cn(
          'w-5 h-5 mb-2',
          active ? 'text-blue-600' : 'text-slate-500',
        )}
      />
      <div className="text-[13px] font-semibold text-slate-900 mb-1">
        {title}
      </div>
      <div className="text-[11px] text-slate-600 leading-snug">
        {subtitle}
      </div>
    </button>
  )
}

function Field({
  label,
  required,
  hint,
  children,
}: {
  label: string
  required?: boolean
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-slate-700 mb-1">
        {label}
        {required && <span className="text-rose-600 ml-0.5">*</span>}
        {hint && (
          <span className="ml-2 font-normal text-[10px] text-slate-500">
            {hint}
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

const inputCls =
  'w-full h-8 px-2.5 text-[13px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
