'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import ProductTypePicker from '@/components/products/ProductTypePicker'

type Mode = 'parent' | 'variant'

interface ParentOption {
  id: string
  sku: string
  name: string
}

interface Props {
  open: boolean
  onClose: () => void
  /** Called after a successful create so the grid can refetch /
   *  optimistically prepend the new row. Receives the created
   *  product. */
  onCreated: (product: any) => void
  /** Existing master products the user can pick as parent for a
   *  variant. Filtered to isParent || (children.length === 0 in
   *  flat mode caller). The grid passes its loaded products list. */
  parentCandidates: ParentOption[]
}

/** T.4 — single modal that handles both new master/parent products
 *  and new variants of an existing parent. Switches POST endpoints
 *  based on `mode`. Validates SKU + name client-side; backend
 *  enforces uniqueness, productType, etc. */
export default function NewProductModal({
  open,
  onClose,
  onCreated,
  parentCandidates,
}: Props) {
  const [mode, setMode] = useState<Mode>('parent')
  const [sku, setSku] = useState('')
  const [name, setName] = useState('')
  const [basePrice, setBasePrice] = useState('0')
  const [totalStock, setTotalStock] = useState('0')
  const [productType, setProductType] = useState('')
  // X.4 — channel + marketplace context drives the product-type
  // picker. Defaults to AMAZON:IT (Xavia primary market) so the most
  // common case loads without the user having to fill them in first.
  const [pickerChannel, setPickerChannel] = useState<
    'AMAZON' | 'EBAY'
  >('AMAZON')
  const [pickerMarketplace, setPickerMarketplace] = useState<string>('IT')
  const [parentId, setParentId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setMode('parent')
      setSku('')
      setName('')
      setBasePrice('0')
      setTotalStock('0')
      setProductType('')
      setParentId('')
      setSubmitting(false)
      setError(null)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, submitting, onClose])

  if (!open) return null

  const valid =
    sku.trim().length > 0 &&
    name.trim().length > 0 &&
    !Number.isNaN(Number(basePrice)) &&
    (mode === 'parent'
      ? productType.trim().length > 0
      : parentId.trim().length > 0)

  const submit = async () => {
    if (!valid || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      let res: Response
      let body: unknown
      if (mode === 'parent') {
        body = {
          sku: sku.trim(),
          name: name.trim(),
          basePrice: Number(basePrice) || 0,
          productType: productType.trim(),
        }
        res = await fetch(`${getBackendUrl()}/api/catalog/products`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      } else {
        body = {
          sku: sku.trim(),
          name: name.trim(),
          basePrice: Number(basePrice) || 0,
          totalStock: Number(totalStock) || 0,
        }
        res = await fetch(
          `${getBackendUrl()}/api/catalog/products/${parentId}/children`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
      }
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.success) {
        throw new Error(
          json?.error?.message ?? json?.error ?? `HTTP ${res.status}`,
        )
      }
      onCreated(json.data)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 backdrop-blur-sm pt-[10vh] px-4"
      role="dialog"
      aria-modal="true"
      onClick={() => !submitting && onClose()}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-slate-200 w-[480px] max-w-[92vw] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-900">
            New product
          </h2>
          <button
            type="button"
            onClick={() => !submitting && onClose()}
            className="text-slate-400 hover:text-slate-700"
            disabled={submitting}
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Mode toggle */}
          <div className="flex items-center gap-1 border border-slate-200 rounded-md p-0.5 bg-slate-50">
            <button
              type="button"
              onClick={() => setMode('parent')}
              className={cn(
                'flex-1 h-7 px-2 text-base rounded transition-colors',
                mode === 'parent'
                  ? 'bg-white text-slate-900 font-semibold shadow-sm'
                  : 'text-slate-600 hover:text-slate-900',
              )}
            >
              Master / parent
            </button>
            <button
              type="button"
              onClick={() => setMode('variant')}
              disabled={parentCandidates.length === 0}
              title={
                parentCandidates.length === 0
                  ? 'No parents available — create a master first'
                  : 'Variant of an existing parent'
              }
              className={cn(
                'flex-1 h-7 px-2 text-base rounded transition-colors',
                mode === 'variant'
                  ? 'bg-white text-slate-900 font-semibold shadow-sm'
                  : 'text-slate-600 hover:text-slate-900',
                parentCandidates.length === 0 && 'opacity-40 cursor-not-allowed',
              )}
            >
              Variant
            </button>
          </div>

          {mode === 'variant' && (
            <Field label="Parent product">
              <select
                value={parentId}
                onChange={(e) => setParentId(e.target.value)}
                className={inputCls}
              >
                <option value="">— Pick a parent —</option>
                {parentCandidates.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.sku} · {p.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="SKU *">
              <input
                type="text"
                value={sku}
                onChange={(e) => setSku(e.target.value)}
                placeholder="UNIQUE-SKU-001"
                className={cn(inputCls, 'font-mono')}
              />
            </Field>
            <Field label="Base price (€)">
              <input
                type="number"
                step="0.01"
                value={basePrice}
                onChange={(e) => setBasePrice(e.target.value)}
                className={inputCls}
              />
            </Field>
          </div>

          <Field label="Name *">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Product name"
              className={inputCls}
            />
          </Field>

          {mode === 'parent' ? (
            <>
              {/* X.4 — channel + marketplace context for the picker.
                  Side-by-side selectors so the dropdown below has a
                  source. Defaults to AMAZON:IT. */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Channel">
                  <select
                    value={pickerChannel}
                    onChange={(e) =>
                      setPickerChannel(
                        e.target.value as 'AMAZON' | 'EBAY',
                      )
                    }
                    className={inputCls}
                  >
                    <option value="AMAZON">Amazon</option>
                    <option value="EBAY">eBay</option>
                  </select>
                </Field>
                <Field label="Marketplace">
                  <select
                    value={pickerMarketplace}
                    onChange={(e) => setPickerMarketplace(e.target.value)}
                    className={inputCls}
                  >
                    <option value="IT">Italy (IT)</option>
                    <option value="DE">Germany (DE)</option>
                    <option value="FR">France (FR)</option>
                    <option value="ES">Spain (ES)</option>
                    <option value="UK">United Kingdom (UK)</option>
                    <option value="NL">Netherlands (NL)</option>
                    <option value="SE">Sweden (SE)</option>
                    <option value="PL">Poland (PL)</option>
                    <option value="US">United States (US)</option>
                  </select>
                </Field>
              </div>

              <Field label="Product type *">
                <ProductTypePicker
                  channel={pickerChannel}
                  marketplace={pickerMarketplace}
                  value={productType}
                  onChange={setProductType}
                  placeholder={`Pick a ${pickerChannel} product type`}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Drives the schema-driven attribute set. Pick from the
                  channel's live taxonomy — refresh in the picker if
                  Amazon's list seems stale.
                </p>
              </Field>
            </>
          ) : (
            <Field label="Initial stock">
              <input
                type="number"
                value={totalStock}
                onChange={(e) => setTotalStock(e.target.value)}
                className={inputCls}
              />
            </Field>
          )}

          {error && (
            <div className="text-base text-rose-700 bg-rose-50 border border-rose-200 rounded px-3 py-2 inline-flex items-start gap-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div>{error}</div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => !submitting && onClose()}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={submit}
            disabled={!valid || submitting}
            loading={submitting}
          >
            {submitting ? (
              <>
                <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                Creating…
              </>
            ) : mode === 'parent' ? (
              'Create master'
            ) : (
              'Create variant'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <div className="text-sm text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  )
}

const inputCls =
  'w-full h-8 px-2 text-base border border-slate-200 rounded-md bg-white focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
