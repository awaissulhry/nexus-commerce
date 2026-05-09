'use client'

/**
 * U.28 — bulk "Set field" modal.
 *
 * Closes the loop the HygieneStrip opened. Operator filters to
 * "missing brand" via the strip → selects N rows → opens this
 * modal → picks `brand` → types "Xavia" → submit. One server
 * call updates all N products + writes an AuditLog row per
 * product.
 *
 * Field whitelist mirrors apps/api/src/routes/products-catalog.routes.ts
 * `fieldHandlers`. Each field configures the editor type + label
 * the operator sees.
 *
 * Lazy-loaded via next/dynamic from BulkActionBar so the form
 * chunk only ships when the operator opens it.
 */

import { useState } from 'react'
import { Loader2, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface SetFieldModalProps {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}

type EditorKind = 'text' | 'textarea' | 'number' | 'select'

interface FieldDef {
  field: string
  label: string
  hint: string
  kind: EditorKind
  options?: Array<{ value: string; label: string }>
  step?: number
  min?: number
  /** When true, an empty input → null (clear the field). */
  allowClear?: boolean
}

const FIELDS: FieldDef[] = [
  {
    field: 'brand',
    label: 'Brand',
    hint: 'e.g. Xavia, Alpinestars, Dainese',
    kind: 'text',
    allowClear: true,
  },
  {
    field: 'productType',
    label: 'Product type',
    hint: 'OUTERWEAR / PANTS / GLOVES / HELMET / BOOTS / PROTECTIVE / BAG',
    kind: 'text',
    allowClear: true,
  },
  {
    field: 'manufacturer',
    label: 'Manufacturer',
    hint: 'Legal manufacturer name as shown on labelling',
    kind: 'text',
    allowClear: true,
  },
  {
    field: 'description',
    label: 'Description',
    hint: 'Master master description (HTML allowed). For AI-generated long-form copy use the AI fill button instead.',
    kind: 'textarea',
    allowClear: true,
  },
  {
    field: 'fulfillmentMethod',
    label: 'Fulfillment method',
    hint: 'Default fulfillment for new listings',
    kind: 'select',
    options: [
      { value: 'FBA', label: 'FBA' },
      { value: 'FBM', label: 'FBM' },
      { value: '', label: '— (clear)' },
    ],
  },
  {
    field: 'lowStockThreshold',
    label: 'Low-stock threshold',
    hint: 'Alert fires when totalStock ≤ this value',
    kind: 'number',
    min: 0,
  },
  {
    field: 'costPrice',
    label: 'Cost price',
    hint: 'Cost of goods (€). Drives margin calc + min-price guard.',
    kind: 'number',
    step: 0.01,
    min: 0,
    allowClear: true,
  },
  {
    field: 'minMargin',
    label: 'Min margin %',
    hint: 'Floor for the pricing engine (e.g. 15 = 15%)',
    kind: 'number',
    step: 0.1,
    allowClear: true,
  },
]

export default function SetFieldModal({
  productIds,
  onClose,
  onComplete,
}: SetFieldModalProps) {
  const { toast } = useToast()
  const [field, setField] = useState<string>('brand')
  const [value, setValue] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)

  const def = FIELDS.find((f) => f.field === field) ?? FIELDS[0]

  const submit = async () => {
    setSubmitting(true)
    try {
      // Coerce per field kind. Server re-validates; we just shape
      // the payload to match each field's expected JSON type.
      let payloadValue: string | number | null
      const trimmed = value.trim()
      if (def.kind === 'number') {
        if (trimmed === '') {
          if (!def.allowClear) {
            toast.error(`${def.label} is required`)
            return
          }
          payloadValue = null
        } else {
          const n = Number(trimmed)
          if (!Number.isFinite(n)) {
            toast.error(`${def.label} must be a number`)
            return
          }
          payloadValue = n
        }
      } else if (def.kind === 'select') {
        payloadValue = trimmed === '' ? null : trimmed
      } else {
        // text + textarea
        if (trimmed === '' && !def.allowClear) {
          toast.error(`${def.label} is required`)
          return
        }
        payloadValue = trimmed === '' ? null : value
      }

      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-set-field`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds,
            field: def.field,
            value: payloadValue,
          }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      const j = await res.json()
      const display =
        payloadValue === null
          ? '(cleared)'
          : typeof payloadValue === 'string' && payloadValue.length > 40
            ? payloadValue.slice(0, 40) + '…'
            : String(payloadValue)
      toast.success(
        `Set ${def.label.toLowerCase()} = ${display} on ${j.changed} product${j.changed === 1 ? '' : 's'}`,
      )
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds, source: 'bulk-set-field', field: def.field },
      })
      onComplete()
    } catch (e) {
      toast.error(
        `Bulk set failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title={
        <span className="inline-flex items-center gap-1.5">
          <Pencil size={14} /> Set field on {productIds.length} product
          {productIds.length === 1 ? '' : 's'}
        </span>
      }
      description="Pick a field, type the value, apply. One AuditLog row per product. Status / stock / price use the dedicated bulk actions above instead."
    >
        <div className="p-5 space-y-4 overflow-y-auto">
          <div className="space-y-2">
            <label
              htmlFor="set-field-field"
              className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block"
            >
              Field
            </label>
            <select
              id="set-field-field"
              value={field}
              onChange={(e) => {
                setField(e.target.value)
                setValue('')
              }}
              className="h-8 px-2 text-base border border-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 rounded w-full"
            >
              {FIELDS.map((f) => (
                <option key={f.field} value={f.field}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <label
              htmlFor="set-field-value"
              className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block"
            >
              {def.label}
              {def.allowClear && (
                <span className="ml-2 text-xs font-normal normal-case text-slate-400 dark:text-slate-500">
                  (leave blank to clear on every selected row)
                </span>
              )}
            </label>
            {def.kind === 'select' ? (
              <select
                id="set-field-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-8 px-2 text-base border border-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 rounded w-full"
              >
                <option value="">— pick —</option>
                {def.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : def.kind === 'textarea' ? (
              <textarea
                id="set-field-value"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                rows={6}
                className="px-2 py-1.5 text-base border border-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 rounded w-full font-mono"
              />
            ) : (
              <input
                id="set-field-value"
                type={def.kind === 'number' ? 'number' : 'text'}
                step={def.step}
                min={def.min}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-8 px-2 text-base border border-slate-200 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100 rounded w-full"
              />
            )}
            <div className="text-sm text-slate-500 dark:text-slate-400">
              {def.hint}
            </div>
          </div>

          <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 rounded p-2.5 text-sm text-amber-800 dark:text-amber-300">
            This writes to <span className="font-mono">{def.field}</span>{' '}
            on all {productIds.length} selected products in one
            transaction. Per-row AuditLog rows are written so you can
            trace what changed.
          </div>
        </div>

        <ModalFooter className="!justify-between">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-slate-900 dark:bg-slate-100 dark:text-slate-900 text-white border-slate-900 dark:border-slate-100 hover:bg-slate-800 dark:hover:bg-slate-200"
            icon={
              submitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Pencil size={12} />
              )
            }
          >
            {submitting
              ? 'Applying…'
              : `Apply to ${productIds.length} product${productIds.length === 1 ? '' : 's'}`}
          </Button>
        </ModalFooter>
    </Modal>
  )
}
