// SPC.1 — single-product form-based create flow.
//
// Original `/products/new` auto-created a placeholder draft + dropped
// the operator into the listing wizard. Operator feedback (#19): a
// real form is wanted for the "I'm adding one new SKU and want to
// fill in the master properly first" use case.
//
// This page is now form-first. Auto-create-plus-wizard is preserved
// below as a "Quick draft" link for operators who want the old
// behaviour.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertCircle, Loader2, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'

interface FormState {
  sku: string
  name: string
  brand: string
  basePrice: string
  initialStock: string
  productType: string
}

const EMPTY: FormState = {
  sku: '',
  name: '',
  brand: '',
  basePrice: '',
  initialStock: '',
  productType: 'GENERIC',
}

export default function CreateProductWizard() {
  const router = useRouter()
  const [form, setForm] = useState<FormState>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quickDraftBusy, setQuickDraftBusy] = useState(false)

  const update = (patch: Partial<FormState>) =>
    setForm((prev) => ({ ...prev, ...patch }))

  const validate = (): string | null => {
    if (form.sku.trim().length === 0) return 'SKU is required.'
    if (form.name.trim().length === 0) return 'Master name is required.'
    const price = Number(form.basePrice)
    if (form.basePrice.trim().length === 0 || !Number.isFinite(price) || price < 0)
      return 'Base price is required and must be ≥ 0.'
    if (form.initialStock.trim().length > 0) {
      const stock = Number(form.initialStock)
      if (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock))
        return 'Initial stock must be a non-negative integer.'
    }
    return null
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const err = validate()
    if (err) {
      setError(err)
      return
    }
    setError(null)
    setBusy(true)
    try {
      // POST /api/products. Server validates uniqueness on SKU and
      // applies categoryAttributes / productType invariants. The
      // generic productType "GENERIC" lets the operator skip the
      // schema-validation gate entirely; refining the productType
      // happens later in the listing wizard.
      const res = await fetch(`${getBackendUrl()}/api/products`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: form.sku.trim(),
          name: form.name.trim(),
          basePrice: Number(form.basePrice),
          productType: form.productType,
          // Brand persists as a Product field; the bulk-edit + edit
          // pages already read this column, so populating here keeps
          // the operator from a separate edit pass.
          brand: form.brand.trim() || undefined,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail =
          (json?.error?.message as string | undefined) ??
          json?.error ??
          `HTTP ${res.status}`
        setError(detail)
        return
      }
      const productId = json?.product?.id ?? json?.data?.id ?? json?.id
      if (typeof productId !== 'string' || productId.length === 0) {
        setError("Created — but couldn't read the product ID back.")
        return
      }
      // Initial stock is set via a follow-up call when the operator
      // entered a value. Failure here doesn't block the redirect —
      // the master exists; the operator can adjust stock from
      // /products/[id]/edit (Inventory tab).
      const initialStock = form.initialStock.trim()
      if (initialStock.length > 0 && Number(initialStock) > 0) {
        try {
          await fetch(`${getBackendUrl()}/api/inventory/${productId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ quantity: Number(initialStock) }),
          })
        } catch {
          // Non-fatal — operator lands on the edit page where they
          // can fix stock if it didn't take.
        }
      }
      router.replace(`/products/${productId}/edit`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // Preserved auto-create flow — fallback for operators who want
  // the old "drop me into the listing wizard immediately" behaviour.
  // Same shape as the original SS implementation.
  const onQuickDraft = async () => {
    setQuickDraftBusy(true)
    setError(null)
    try {
      const today = new Date()
      const yyyymmdd =
        today.getFullYear().toString() +
        String(today.getMonth() + 1).padStart(2, '0') +
        String(today.getDate()).padStart(2, '0')
      const suffix = Math.random().toString(36).slice(2, 6).toUpperCase()
      const draftSku = `NEW-${yyyymmdd}-${suffix}`
      const res = await fetch(`${getBackendUrl()}/api/products/create-wizard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `create-wizard:${draftSku}`,
        },
        body: JSON.stringify({
          sku: draftSku,
          name: 'Untitled product',
          basePrice: 0,
        }),
      })
      const json = (await res.json().catch(() => ({}))) as {
        success?: boolean
        product?: { id: string }
        error?: string
      }
      if (!res.ok || !json?.success || !json.product?.id) {
        setError(
          json?.error ?? `Couldn't start a new draft (HTTP ${res.status}).`,
        )
        return
      }
      router.replace(`/products/${json.product.id}/list-wizard`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setQuickDraftBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 px-6 py-10">
      <div className="max-w-xl mx-auto">
        <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100 mb-1">
          New product
        </h1>
        <p className="text-md text-slate-600 dark:text-slate-400 mb-6">
          Set up a master SKU. You can refine the product type, channels,
          attributes, and images later from the edit page or the listing
          wizard.
        </p>

        <form
          onSubmit={onSubmit}
          className="border border-slate-200 dark:border-slate-700 rounded-lg bg-white dark:bg-slate-900 p-5 space-y-4"
        >
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 border border-rose-200 dark:border-rose-800 rounded bg-rose-50 dark:bg-rose-900/20 text-sm text-rose-800 dark:text-rose-200">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="break-words">{error}</span>
            </div>
          )}

          <div>
            <label
              htmlFor="sku"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              SKU <span className="text-rose-600">*</span>
            </label>
            <input
              id="sku"
              type="text"
              value={form.sku}
              onChange={(e) => update({ sku: e.target.value })}
              placeholder="e.g. XAVIA-JKT-RACER-BLK"
              className="w-full px-3 py-2 text-base border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 font-mono"
              required
              autoFocus
            />
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Unique master SKU. Channel-specific SKUs (Amazon SKU, eBay
              custom label) are generated by the listing wizard.
            </p>
          </div>

          <div>
            <label
              htmlFor="name"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Master name <span className="text-rose-600">*</span>
            </label>
            <input
              id="name"
              type="text"
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="e.g. Racer Pro Leather Jacket"
              className="w-full px-3 py-2 text-base border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900"
              required
            />
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Internal product name. Per-marketplace AI-generated titles
              live separately on each channel.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label
                htmlFor="brand"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Brand
              </label>
              <input
                id="brand"
                type="text"
                value={form.brand}
                onChange={(e) => update({ brand: e.target.value })}
                placeholder="e.g. Xavia"
                className="w-full px-3 py-2 text-base border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label
                htmlFor="basePrice"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Base price <span className="text-rose-600">*</span>
              </label>
              <input
                id="basePrice"
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={form.basePrice}
                onChange={(e) => update({ basePrice: e.target.value })}
                placeholder="0.00"
                className="w-full px-3 py-2 text-base border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums"
                required
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="initialStock"
              className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
            >
              Initial stock
            </label>
            <input
              id="initialStock"
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              value={form.initialStock}
              onChange={(e) => update({ initialStock: e.target.value })}
              placeholder="0"
              className="w-full px-3 py-2 text-base border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-900 tabular-nums"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              Optional. Set the on-hand quantity at the default location.
              You can manage bin/lot detail later from /fulfillment/stock.
            </p>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={busy || quickDraftBusy}
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
              Create + go to edit
              <ArrowRight className="w-3 h-3" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => router.push('/products')}
              disabled={busy || quickDraftBusy}
            >
              Cancel
            </Button>
          </div>
        </form>

        <div className="mt-6 text-center text-sm text-slate-500 dark:text-slate-400">
          Or{' '}
          <button
            type="button"
            onClick={onQuickDraft}
            disabled={busy || quickDraftBusy}
            className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
          >
            {quickDraftBusy ? 'creating draft…' : 'create an empty draft'}
          </button>{' '}
          and skip straight to the listing wizard.
        </div>
      </div>
    </div>
  )
}
