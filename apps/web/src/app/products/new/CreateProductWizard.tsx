// PP / QQ — single-product create wizard.
//
// QQ — slimmed from a 6-step master-data form to just 2 steps:
//   1. Basics (SKU, name, basePrice — minimum to create a row)
//   2. Variants (optional — define parent/child structure up front)
//
// On submit we POST /api/products/create-wizard, get the new
// productId, then redirect into the existing listing wizard at
// /products/:id/list-wizard. Everything dynamic — channel + market
// selection, eBay aspects, Amazon attribute schema, productType
// pickers, AI generation, image validation, per-marketplace
// pricing, submit orchestration — already lives in the listing
// wizard. Re-implementing any of it here would just fork the
// codebase.
//
// Result: the user gets the SAME wizard shell + same dynamism for
// new products as for existing ones, with two extra "set up the
// shell" steps at the front. Variants (parent/child) are captured
// here so they exist as ProductVariation rows by the time the
// listing wizard's Step 4 Variations sees them.

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
  id: string // local key only; not persisted
  sku: string
  name: string
  attrs: Record<string, string>
  price: string
  stock: string
}

interface State {
  // Step 1 — bare minimum to create a row. Brand / productType /
  // description are optional here because the listing wizard's
  // Step 2 (productType picker) and Step 5 (attributes) will fill
  // them in per-channel anyway.
  sku: string
  name: string
  brand: string
  basePrice: string
  // Step 2
  variations: VariationDraft[]
}

const INITIAL: State = {
  sku: '',
  name: '',
  brand: '',
  basePrice: '',
  variations: [],
}

const STEPS = [
  { id: 1, label: 'Basics' },
  { id: 2, label: 'Variants' },
] as const

export default function CreateProductWizard() {
  const router = useRouter()
  const [state, setState] = useState<State>(INITIAL)
  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const set = useCallback(<K extends keyof State>(k: K, v: State[K]) => {
    setState((s) => ({ ...s, [k]: v }))
  }, [])

  const stepValid = useMemo(() => {
    if (step === 1) {
      const priceNum = Number(state.basePrice)
      return (
        state.sku.trim().length > 0 &&
        state.name.trim().length > 0 &&
        Number.isFinite(priceNum) &&
        priceNum >= 0
      )
    }
    if (step === 2) {
      return state.variations.every((v) => v.sku.trim().length > 0)
    }
    return true
  }, [step, state])

  const isLast = step === STEPS.length
  const canBack = step > 1
  const canForward = step < STEPS.length && stepValid

  const handleSubmit = useCallback(
    async (mode: 'list' | 'edit' | 'another') => {
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
          basePrice: Number(state.basePrice) || 0,
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
            'Idempotency-Key': `create-wizard:${body.sku}`,
          },
          body: JSON.stringify(body),
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok || !json?.success) {
          setError(json?.error ?? `HTTP ${res.status}`)
          return
        }
        const productId = json.product.id
        if (mode === 'list') {
          router.push(`/products/${productId}/list-wizard?fromCreate=1`)
        } else if (mode === 'another') {
          // Reset state for the next product without leaving the page,
          // so a user adding 5 products in a row doesn't have to walk
          // back through navigation.
          setState(INITIAL)
          setStep(1)
          setSubmitting(false)
          return
        } else {
          router.push(`/products/${productId}/edit?created=1`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSubmitting(false)
      }
    },
    [state, router],
  )

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
            className="flex items-center justify-center gap-2 max-w-3xl mx-auto"
          >
            {STEPS.map((s, idx) => {
              const isCurrent = s.id === step
              const isCompleted = s.id < step
              const isClickable = s.id <= step
              return (
                <div key={s.id} className="flex items-center gap-2">
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
                      'text-[12px]',
                      isCurrent ? 'text-slate-900 font-medium' : 'text-slate-500',
                    )}
                  >
                    {s.label}
                  </span>
                  {idx < STEPS.length - 1 && (
                    <div
                      className={cn(
                        'h-0.5 w-12 mx-2',
                        s.id < step ? 'bg-blue-600' : 'bg-slate-200',
                      )}
                    />
                  )}
                </div>
              )
            })}
          </ol>
          <p className="text-center text-[11px] text-slate-500 mt-2">
            After this, the listing wizard handles channels, markets,
            categories, attributes, pricing and submit — same as for
            existing products.
          </p>
        </nav>
      </div>

      {/* ── Step body ─────────────────────────────────────────── */}
      <div className="flex-1 px-6 py-8">
        <div className="max-w-2xl mx-auto">
          {step === 1 && <StepBasics state={state} set={set} />}
          {step === 2 && <StepVariations state={state} setState={setState} />}

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
        <div className="max-w-2xl mx-auto px-6 py-3 flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!canBack || submitting}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
          >
            Back
          </Button>
          <span className="text-[11px] text-slate-500 mx-auto">
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
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                loading={submitting}
                disabled={submitting || !stepValid}
                onClick={() => handleSubmit('edit')}
                title="Create and open the edit page"
              >
                Save draft
              </Button>
              <Button
                variant="primary"
                size="sm"
                loading={submitting}
                disabled={submitting || !stepValid}
                onClick={() => handleSubmit('list')}
                title="Create and continue into the listing wizard"
              >
                Create & list on channels →
              </Button>
            </div>
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
    <Card
      title="Basics"
      description="Just the bare minimum so the product exists. Channels, productType, identifiers, attributes, pricing per market — all of that comes next in the listing wizard."
    >
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
          <Field label="Brand" hint="Optional — can be set per channel later">
            <input
              type="text"
              value={state.brand}
              onChange={(e) => set('brand', e.target.value)}
              placeholder="Xavia"
              className={inputCls}
            />
          </Field>
          <Field label="Base price" required hint="Per-market overrides next">
            <input
              type="number"
              min="0"
              step="0.01"
              value={state.basePrice}
              onChange={(e) => set('basePrice', e.target.value)}
              placeholder="0.00"
              className={inputCls}
            />
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
      title="Variants (optional)"
      description="Skip this for a single-SKU product. Add child rows for size / colour / etc — they'll exist as ProductVariation records by the time the listing wizard's Step 4 picks the variation theme. The listing wizard handles per-channel variation themes (Amazon SIZE_COLOR, eBay aspects flagged variant-eligible) automatically once you reach it."
    >
      {state.variations.length === 0 ? (
        <div className="text-center py-6">
          <p className="text-[12px] text-slate-500 mb-3">
            No variants yet. Add one or click <strong>Save draft</strong> /{' '}
            <strong>Create &amp; list</strong> to continue.
          </p>
          <Button variant="secondary" size="sm" onClick={addRow}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Add variant
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
            Add another variant
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
          aria-label="Remove variant"
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
        <p className="mt-1 text-[10px] text-slate-400">
          Free-form for now (size, color, …). The listing wizard's Step
          4 maps these to per-channel variation themes (Amazon
          SIZE_COLOR, eBay variant-eligible aspects) automatically.
        </p>
      </div>
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
