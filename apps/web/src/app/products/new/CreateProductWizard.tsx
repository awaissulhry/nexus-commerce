// PP — create-product wizard. Mirrors the listing wizard's shell
// pattern (stepper + sticky header + step-by-step form) but creates
// a new master product instead of publishing one. Channel-specific
// listing work is the listing wizard's job; this stays focused on
// master data + optional variations + creation.
//
// Steps:
//   1 Basics       SKU, name, brand, productType, description
//   2 Identifiers  UPC / EAN / GTIN / manufacturer
//   3 Pricing      basePrice, costPrice
//   4 Inventory    totalStock, lowStockThreshold + dimensions
//   5 Variations   optional list of { sku, attrs, price, stock }
//   6 Review       confirm + create
//
// On success the user lands on /products/:id/edit with a banner
// linking to /products/:id/list-wizard so they can publish to
// channels (Amazon, eBay, Shopify, Woo) — same wizard we already
// shipped, no new code path needed.

'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface VariationDraft {
  id: string // local-only client id for keying / removal
  sku: string
  name: string
  attrs: Record<string, string>
  price: string // string so the input stays controlled until commit
  stock: string
}

interface State {
  // Step 1
  sku: string
  name: string
  brand: string
  productType: string
  description: string
  // Step 2
  upc: string
  ean: string
  gtin: string
  manufacturer: string
  // Step 3
  basePrice: string
  costPrice: string
  // Step 4
  totalStock: string
  lowStockThreshold: string
  weightValue: string
  weightUnit: 'kg' | 'g' | 'lb' | 'oz'
  dimLength: string
  dimWidth: string
  dimHeight: string
  dimUnit: 'cm' | 'mm' | 'in'
  // Step 5
  variations: VariationDraft[]
}

const INITIAL: State = {
  sku: '',
  name: '',
  brand: '',
  productType: '',
  description: '',
  upc: '',
  ean: '',
  gtin: '',
  manufacturer: '',
  basePrice: '',
  costPrice: '',
  totalStock: '',
  lowStockThreshold: '',
  weightValue: '',
  weightUnit: 'kg',
  dimLength: '',
  dimWidth: '',
  dimHeight: '',
  dimUnit: 'cm',
  variations: [],
}

const STEPS = [
  { id: 1, label: 'Basics' },
  { id: 2, label: 'Identifiers' },
  { id: 3, label: 'Pricing' },
  { id: 4, label: 'Inventory' },
  { id: 5, label: 'Variations' },
  { id: 6, label: 'Review' },
] as const

export default function CreateProductWizard() {
  const router = useRouter()
  const [state, setState] = useState<State>(INITIAL)
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Track which channels the user wants to push to AFTER create.
  // We stash these into the success step so the "List on channel"
  // CTAs jump straight into the listing wizard with the right
  // pre-selection.
  const set = useCallback(<K extends keyof State>(k: K, v: State[K]) => {
    setState((s) => ({ ...s, [k]: v }))
  }, [])

  // ── Per-step validation gates ───────────────────────────────────
  const stepValid = useMemo(() => {
    switch (step) {
      case 1:
        return state.sku.trim().length > 0 && state.name.trim().length > 0
      case 3: {
        const n = Number(state.basePrice)
        return Number.isFinite(n) && n >= 0
      }
      case 5:
        return state.variations.every((v) => v.sku.trim().length > 0)
      default:
        return true
    }
  }, [step, state])

  const canBack = step > 1
  const canForward = step < STEPS.length && stepValid
  const isLast = step === STEPS.length

  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    setError(null)
    try {
      const numericOrUndef = (s: string) => {
        const t = s.trim()
        if (!t) return undefined
        const n = Number(t)
        return Number.isFinite(n) ? n : undefined
      }
      const body = {
        sku: state.sku.trim(),
        name: state.name.trim(),
        brand: state.brand.trim() || null,
        productType: state.productType.trim() || null,
        description: state.description.trim() || null,
        basePrice: Number(state.basePrice) || 0,
        costPrice: numericOrUndef(state.costPrice),
        totalStock: numericOrUndef(state.totalStock),
        lowStockThreshold: numericOrUndef(state.lowStockThreshold),
        upc: state.upc.trim() || null,
        ean: state.ean.trim() || null,
        gtin: state.gtin.trim() || null,
        manufacturer: state.manufacturer.trim() || null,
        weightValue: numericOrUndef(state.weightValue),
        weightUnit: state.weightUnit,
        dimLength: numericOrUndef(state.dimLength),
        dimWidth: numericOrUndef(state.dimWidth),
        dimHeight: numericOrUndef(state.dimHeight),
        dimUnit: state.dimUnit,
        variations: state.variations.map((v) => ({
          sku: v.sku.trim(),
          name: v.name.trim() || null,
          variationAttributes: v.attrs,
          price: numericOrUndef(v.price),
          stock: numericOrUndef(v.stock),
        })),
      }
      const res = await fetch(`${getBackendUrl()}/api/products/create-wizard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // NN.2 — idempotency key derived from sku so a double-click
          // doesn't double-create. Server's idempotency cache is
          // 10-min TTL which is plenty for the wizard window.
          'Idempotency-Key': `create-wizard:${body.sku}`,
        },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json?.success) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      // PP — success. Hand off to the edit page; user can then click
      // "List on Channel" to jump into the existing listing wizard.
      router.push(`/products/${json.product.id}/edit?created=1`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }, [state, router])

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between">
          <button
            type="button"
            onClick={() => router.push('/products')}
            className="inline-flex items-center gap-1 text-[12px] text-slate-600 hover:text-slate-900"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Back to products
          </button>
          <h1 className="text-[14px] font-semibold text-slate-900">
            Create new product
          </h1>
          <button
            type="button"
            onClick={() => router.push('/products')}
            className="text-slate-400 hover:text-slate-700"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {/* Stepper */}
        <nav
          aria-label="Create product steps"
          className="border-t border-slate-100 bg-white px-6 py-3"
        >
          <ol
            role="tablist"
            aria-orientation="horizontal"
            className="flex items-center justify-center gap-1 max-w-3xl mx-auto"
          >
            {STEPS.map((s, idx) => {
              const isCurrent = s.id === step
              const isCompleted = s.id < step
              const isClickable = s.id <= step
              return (
                <div key={s.id} className="flex items-center gap-1">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isCurrent}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-label={`Step ${s.id} of ${STEPS.length}: ${s.label}`}
                    tabIndex={isCurrent ? 0 : -1}
                    onClick={() => isClickable && setStep(s.id)}
                    disabled={!isClickable}
                    className={cn(
                      'relative flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-medium transition-colors',
                      isCurrent &&
                        'bg-blue-600 text-white ring-4 ring-blue-100',
                      isCompleted &&
                        !isCurrent &&
                        'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer',
                      !isCompleted &&
                        !isCurrent &&
                        'bg-slate-100 text-slate-400',
                    )}
                  >
                    {isCompleted ? <Check className="w-3.5 h-3.5" /> : s.id}
                  </button>
                  <span
                    className={cn(
                      'text-[11px] hidden sm:inline',
                      isCurrent ? 'text-slate-900 font-medium' : 'text-slate-500',
                    )}
                  >
                    {s.label}
                  </span>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={cn(
                        'h-0.5 w-6 mx-1',
                        s.id < step ? 'bg-blue-600' : 'bg-slate-200',
                      )}
                    />
                  )}
                </div>
              )
            })}
          </ol>
        </nav>
      </div>

      {/* ── Step body ─────────────────────────────────────────── */}
      <div className="flex-1 px-6 py-8">
        <div className="max-w-2xl mx-auto">
          {step === 1 && <StepBasics state={state} set={set} />}
          {step === 2 && <StepIdentifiers state={state} set={set} />}
          {step === 3 && <StepPricing state={state} set={set} />}
          {step === 4 && <StepInventory state={state} set={set} />}
          {step === 5 && <StepVariations state={state} setState={setState} />}
          {step === 6 && <StepReview state={state} />}

          {error && (
            <div className="mt-4 px-4 py-3 border border-rose-200 bg-rose-50 rounded-lg text-[12px] text-rose-700 inline-flex items-start gap-2 max-w-full">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── Footer nav ────────────────────────────────────────── */}
      <div className="border-t border-slate-200 bg-white sticky bottom-0">
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canBack || submitting}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
          >
            Back
          </Button>
          <span className="text-[11px] text-slate-500">
            Step {step} of {STEPS.length}
          </span>
          {!isLast ? (
            <Button
              variant="primary"
              size="sm"
              disabled={!canForward}
              onClick={() => setStep((s) => Math.min(STEPS.length, s + 1))}
            >
              Continue
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              loading={submitting}
              disabled={submitting}
              onClick={handleSubmit}
            >
              Create product
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Step components ────────────────────────────────────────────────

function StepBasics({
  state,
  set,
}: {
  state: State
  set: <K extends keyof State>(k: K, v: State[K]) => void
}) {
  return (
    <Card title="Basics" description="The core master data for this product.">
      <div className="space-y-3">
        <Field label="SKU" required>
          <input
            type="text"
            value={state.sku}
            onChange={(e) => set('sku', e.target.value)}
            placeholder="XAV-OUTERWEAR-001"
            className={inputCls}
            autoFocus
          />
        </Field>
        <Field label="Name" required>
          <input
            type="text"
            value={state.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="Xavia Storm Adventure Jacket"
            className={inputCls}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Brand">
            <input
              type="text"
              value={state.brand}
              onChange={(e) => set('brand', e.target.value)}
              placeholder="Xavia"
              className={inputCls}
            />
          </Field>
          <Field label="Product Type" hint="e.g. OUTERWEAR, HELMET, GLOVES">
            <input
              type="text"
              value={state.productType}
              onChange={(e) => set('productType', e.target.value)}
              placeholder="OUTERWEAR"
              className={inputCls}
            />
          </Field>
        </div>
        <Field label="Description" hint="HTML allowed; can be edited later">
          <textarea
            rows={4}
            value={state.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="High-end Italian motorcycle gear …"
            className={cn(inputCls, 'min-h-[80px] resize-y')}
          />
        </Field>
      </div>
    </Card>
  )
}

function StepIdentifiers({
  state,
  set,
}: {
  state: State
  set: <K extends keyof State>(k: K, v: State[K]) => void
}) {
  return (
    <Card
      title="Identifiers"
      description="UPC / EAN / GTIN are required by Amazon for most categories. eBay accepts 'Does Not Apply' for many — leave blank if you don't have one."
    >
      <div className="space-y-3">
        <Field label="UPC" hint="12 digits (US/CA)">
          <input
            type="text"
            value={state.upc}
            onChange={(e) => set('upc', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="EAN" hint="13 digits (EU)">
          <input
            type="text"
            value={state.ean}
            onChange={(e) => set('ean', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="GTIN" hint="8–14 digits, any GS1 identifier">
          <input
            type="text"
            value={state.gtin}
            onChange={(e) => set('gtin', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Manufacturer">
          <input
            type="text"
            value={state.manufacturer}
            onChange={(e) => set('manufacturer', e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
    </Card>
  )
}

function StepPricing({
  state,
  set,
}: {
  state: State
  set: <K extends keyof State>(k: K, v: State[K]) => void
}) {
  return (
    <Card
      title="Pricing"
      description="Base price is required. Per-channel / per-marketplace overrides happen in the listing wizard."
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Base price" required>
          <input
            type="number"
            min="0"
            step="0.01"
            value={state.basePrice}
            onChange={(e) => set('basePrice', e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Cost price" hint="Used for margin calc">
          <input
            type="number"
            min="0"
            step="0.01"
            value={state.costPrice}
            onChange={(e) => set('costPrice', e.target.value)}
            className={inputCls}
          />
        </Field>
      </div>
    </Card>
  )
}

function StepInventory({
  state,
  set,
}: {
  state: State
  set: <K extends keyof State>(k: K, v: State[K]) => void
}) {
  return (
    <Card
      title="Inventory & dimensions"
      description="All fields optional; required ones (per channel) can be filled in the listing wizard."
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Stock">
            <input
              type="number"
              min="0"
              value={state.totalStock}
              onChange={(e) => set('totalStock', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Low stock alert">
            <input
              type="number"
              min="0"
              value={state.lowStockThreshold}
              onChange={(e) => set('lowStockThreshold', e.target.value)}
              className={inputCls}
            />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Weight">
            <input
              type="number"
              min="0"
              step="0.01"
              value={state.weightValue}
              onChange={(e) => set('weightValue', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Unit">
            <select
              value={state.weightUnit}
              onChange={(e) =>
                set('weightUnit', e.target.value as State['weightUnit'])
              }
              className={inputCls}
            >
              <option value="kg">kg</option>
              <option value="g">g</option>
              <option value="lb">lb</option>
              <option value="oz">oz</option>
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-4 gap-3">
          <Field label="Length">
            <input
              type="number"
              min="0"
              step="0.01"
              value={state.dimLength}
              onChange={(e) => set('dimLength', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Width">
            <input
              type="number"
              min="0"
              step="0.01"
              value={state.dimWidth}
              onChange={(e) => set('dimWidth', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Height">
            <input
              type="number"
              min="0"
              step="0.01"
              value={state.dimHeight}
              onChange={(e) => set('dimHeight', e.target.value)}
              className={inputCls}
            />
          </Field>
          <Field label="Unit">
            <select
              value={state.dimUnit}
              onChange={(e) =>
                set('dimUnit', e.target.value as State['dimUnit'])
              }
              className={inputCls}
            >
              <option value="cm">cm</option>
              <option value="mm">mm</option>
              <option value="in">in</option>
            </select>
          </Field>
        </div>
      </div>
    </Card>
  )
}

function StepVariations({
  state,
  setState,
}: {
  state: State
  setState: React.Dispatch<React.SetStateAction<State>>
}) {
  const addRow = () =>
    setState((s) => ({
      ...s,
      variations: [
        ...s.variations,
        {
          id: `v_${Date.now()}_${s.variations.length}`,
          sku: '',
          name: '',
          attrs: {},
          price: '',
          stock: '',
        },
      ],
    }))
  const removeRow = (id: string) =>
    setState((s) => ({
      ...s,
      variations: s.variations.filter((v) => v.id !== id),
    }))
  const update = (id: string, patch: Partial<VariationDraft>) =>
    setState((s) => ({
      ...s,
      variations: s.variations.map((v) =>
        v.id === id ? { ...v, ...patch } : v,
      ),
    }))

  return (
    <Card
      title="Variations (optional)"
      description="Add child SKUs with size / color / etc. Skip this step if you're creating a single-SKU product."
    >
      {state.variations.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-[12px] text-slate-500 mb-3">
            No variations yet. Add one or skip to Review.
          </p>
          <Button variant="secondary" size="sm" onClick={addRow}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add variation
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {state.variations.map((v, idx) => (
            <VariationRow
              key={v.id}
              row={v}
              index={idx}
              onChange={(patch) => update(v.id, patch)}
              onRemove={() => removeRow(v.id)}
            />
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={addRow}
            className="w-full"
          >
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add another variation
          </Button>
        </div>
      )}
    </Card>
  )
}

function VariationRow({
  row,
  index,
  onChange,
  onRemove,
}: {
  row: VariationDraft
  index: number
  onChange: (patch: Partial<VariationDraft>) => void
  onRemove: () => void
}) {
  const [attrKeyDraft, setAttrKeyDraft] = useState('')
  const [attrValDraft, setAttrValDraft] = useState('')
  const addAttr = () => {
    const k = attrKeyDraft.trim()
    const v = attrValDraft.trim()
    if (!k || !v) return
    onChange({ attrs: { ...row.attrs, [k]: v } })
    setAttrKeyDraft('')
    setAttrValDraft('')
  }
  const removeAttr = (k: string) => {
    const { [k]: _gone, ...rest } = row.attrs
    onChange({ attrs: rest })
  }
  return (
    <div className="border border-slate-200 rounded-lg p-3 bg-white">
      <div className="flex items-center justify-between mb-2">
        <Badge mono variant="info">
          #{index + 1}
        </Badge>
        <button
          type="button"
          onClick={onRemove}
          className="text-rose-500 hover:text-rose-700"
          aria-label="Remove variation"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Field label="Variant SKU" required>
          <input
            type="text"
            value={row.sku}
            onChange={(e) => onChange({ sku: e.target.value })}
            placeholder="XAV-001-RED-L"
            className={inputCls}
          />
        </Field>
        <Field label="Variant name">
          <input
            type="text"
            value={row.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="Red / Large"
            className={inputCls}
          />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-2 mb-2">
        <Field label="Price (opt)">
          <input
            type="number"
            min="0"
            step="0.01"
            value={row.price}
            onChange={(e) => onChange({ price: e.target.value })}
            placeholder="defaults to base"
            className={inputCls}
          />
        </Field>
        <Field label="Stock (opt)">
          <input
            type="number"
            min="0"
            value={row.stock}
            onChange={(e) => onChange({ stock: e.target.value })}
            placeholder="0"
            className={inputCls}
          />
        </Field>
      </div>
      <div>
        <label className="block text-[11px] font-medium text-slate-700 mb-1">
          Attributes
        </label>
        {Object.entries(row.attrs).length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {Object.entries(row.attrs).map(([k, val]) => (
              <span
                key={k}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-slate-100 text-[10px]"
              >
                <span className="font-mono">{k}</span>: {val}
                <button
                  type="button"
                  onClick={() => removeAttr(k)}
                  className="text-slate-500 hover:text-rose-700"
                  aria-label={`Remove ${k}`}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={attrKeyDraft}
            onChange={(e) => setAttrKeyDraft(e.target.value)}
            placeholder="key (color)"
            className={cn(inputCls, 'h-7 text-[11px] flex-1')}
          />
          <input
            type="text"
            value={attrValDraft}
            onChange={(e) => setAttrValDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addAttr()
              }
            }}
            placeholder="value (red)"
            className={cn(inputCls, 'h-7 text-[11px] flex-1')}
          />
          <button
            type="button"
            onClick={addAttr}
            disabled={!attrKeyDraft.trim() || !attrValDraft.trim()}
            className="h-7 px-2 text-[11px] rounded-md border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function StepReview({ state }: { state: State }) {
  return (
    <Card
      title="Review"
      description="Looks good? Click Create. After that you can list it on Amazon, eBay, Shopify or WooCommerce via the existing listing wizard."
    >
      <div className="space-y-3 text-[12px]">
        <ReviewRow label="SKU" value={state.sku} />
        <ReviewRow label="Name" value={state.name} />
        {state.brand && <ReviewRow label="Brand" value={state.brand} />}
        {state.productType && (
          <ReviewRow label="Product type" value={state.productType} />
        )}
        <ReviewRow label="Base price" value={state.basePrice || '0'} mono />
        {state.totalStock && (
          <ReviewRow label="Stock" value={state.totalStock} mono />
        )}
        {(state.upc || state.ean || state.gtin) && (
          <ReviewRow
            label="Identifier"
            value={
              state.upc
                ? `UPC ${state.upc}`
                : state.ean
                ? `EAN ${state.ean}`
                : `GTIN ${state.gtin}`
            }
            mono
          />
        )}
        {state.variations.length > 0 && (
          <div className="mt-2 border-t border-slate-100 pt-2">
            <div className="text-[11px] font-medium text-slate-700 mb-1">
              {state.variations.length} variation
              {state.variations.length === 1 ? '' : 's'}
            </div>
            <ul className="space-y-1">
              {state.variations.map((v) => (
                <li
                  key={v.id}
                  className="text-[11px] text-slate-600 font-mono truncate"
                >
                  {v.sku}
                  {Object.keys(v.attrs).length > 0 &&
                    ` · ${Object.entries(v.attrs)
                      .map(([k, val]) => `${k}=${val}`)
                      .join(', ')}`}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  )
}

function ReviewRow({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span
        className={cn(
          'text-slate-900 truncate text-right',
          mono && 'font-mono tabular-nums',
        )}
      >
        {value}
      </span>
    </div>
  )
}

// ── shared field wrapper ───────────────────────────────────────────

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
  'w-full h-8 px-2.5 text-[12px] border border-slate-200 rounded-md focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
