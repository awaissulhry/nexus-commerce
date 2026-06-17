'use client'

/**
 * F.6.1 (TECH_DEBT #50) — operator-grade New Plan form for the
 * v2024-03-20 FBA inbound wizard.
 *
 * Replaces the F.5 v1 NewPlanButton's PLACEHOLDER body + browser
 * prompt() with a real Modal form:
 *   - Plan name (free text)
 *   - Destination marketplace (dropdown of participating Amazon markets)
 *   - Source address (Xavia Riccione defaults, editable)
 *   - Items (multi-row: SKU autocomplete from /api/products + quantity)
 *
 * Validates client-side (at least one item with sku + qty > 0) before
 * hitting the SP-API. Submission opens a brief "creating…" state since
 * createInboundPlan polls the operation to completion before responding
 * (can take 5-30s).
 */

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, X, Search } from 'lucide-react'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

interface Marketplace {
  code: string
  marketplaceId: string
  currency: string
  isParticipating: boolean
}

interface ProductSuggestion {
  id: string
  sku: string
  name: string | null
}

interface PlanItemRow {
  /** stable id for React keys + remove() */
  rowId: number
  sku: string
  quantity: number
  productName: string | null
  /** suppress autocomplete after a pick */
  picked: boolean
}

interface NewPlanModalProps {
  open: boolean
  onClose: () => void
  onCreated: (planRowId: string) => void
}

const DEFAULT_SOURCE_ADDRESS = {
  name: 'Xavia',
  addressLine1: 'Via Esempio 1',
  addressLine2: '',
  city: 'Riccione',
  stateOrProvinceCode: 'RN',
  countryCode: 'IT',
  postalCode: '47838',
  phoneNumber: '',
  email: '',
  companyName: 'Xavia',
}

let nextRowId = 1
function makeRow(): PlanItemRow {
  return { rowId: nextRowId++, sku: '', quantity: 1, productName: null, picked: false }
}

export function NewPlanModal({ open, onClose, onCreated }: NewPlanModalProps) {
  const { toast } = useToast()

  // Form state
  const [name, setName] = useState('')
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([])
  const [destinationCode, setDestinationCode] = useState('IT')
  const [src, setSrc] = useState(DEFAULT_SOURCE_ADDRESS)
  const [items, setItems] = useState<PlanItemRow[]>([makeRow()])
  const [submitting, setSubmitting] = useState(false)

  // Default name = "Inbound <today>" (operator can edit before submit)
  useEffect(() => {
    if (open && !name) {
      setName(`Inbound ${new Date().toLocaleDateString('it-IT')}`)
    }
  }, [open, name])

  // Load participating Amazon marketplaces once on open. Defaults
  // destinationCode to IT but operator can pick any.
  useEffect(() => {
    if (!open || marketplaces.length > 0) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`${getBackendUrl()}/api/amazon/participations`, {
          credentials: 'include',
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        // Sort: participating first, then alphabetical by code
        const rows: Marketplace[] = (json.marketplaces ?? [])
          .filter((m: Marketplace) => m.marketplaceId)
          .sort((a: Marketplace, b: Marketplace) => {
            if (a.isParticipating !== b.isParticipating) {
              return a.isParticipating ? -1 : 1
            }
            return a.code.localeCompare(b.code)
          })
        setMarketplaces(rows)
      } catch (e) {
        if (!cancelled) {
          toast.error(
            `Failed to load marketplaces: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, marketplaces.length, toast])

  const destinationMarketplaceId = useMemo(
    () => marketplaces.find((m) => m.code === destinationCode)?.marketplaceId,
    [marketplaces, destinationCode],
  )

  // Reset form on close so re-opening starts clean.
  useEffect(() => {
    if (!open) {
      setName('')
      setSrc(DEFAULT_SOURCE_ADDRESS)
      setItems([makeRow()])
      setDestinationCode('IT')
    }
  }, [open])

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    destinationMarketplaceId !== undefined &&
    items.some((it) => it.sku.trim().length > 0 && it.quantity > 0) &&
    src.name && src.addressLine1 && src.city && src.postalCode && src.countryCode

  const handleSubmit = async () => {
    if (!canSubmit || !destinationMarketplaceId) return
    const validItems = items.filter((it) => it.sku.trim() && it.quantity > 0)
    setSubmitting(true)
    try {
      const body = {
        spApi: {
          name: name.trim(),
          destinationMarketplaces: [destinationMarketplaceId],
          msku: validItems[0]!.sku, // SP-API: required top-level (legacy field)
          items: validItems.map((it) => ({
            msku: it.sku.trim(),
            quantity: it.quantity,
          })),
          sourceAddress: {
            name: src.name,
            addressLine1: src.addressLine1,
            ...(src.addressLine2 ? { addressLine2: src.addressLine2 } : {}),
            city: src.city,
            stateOrProvinceCode: src.stateOrProvinceCode,
            countryCode: src.countryCode,
            postalCode: src.postalCode,
            ...(src.phoneNumber ? { phoneNumber: src.phoneNumber } : {}),
            ...(src.email ? { email: src.email } : {}),
            ...(src.companyName ? { companyName: src.companyName } : {}),
          },
        },
      }
      const res = await fetch(`${getBackendUrl()}/api/fba/inbound/v2`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const j = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}`)
      toast.success(`Plan created (${validItems.length} item${validItems.length === 1 ? '' : 's'}) — picking packing options next`)
      onCreated(j.planRowId)
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New FBA inbound plan"
      description="v2024-03-20 multi-step flow — each step polls SP-API for completion. Submission can take 5-30s while Amazon validates the plan."
      size="2xl"
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
    >
      <ModalBody>
        <div className="space-y-5">
          {/* Plan name + destination */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Plan name" required>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={submitting}
                className="h-9 w-full px-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
                placeholder="Inbound 21/05/2026"
              />
            </Field>
            <Field label="Destination marketplace" required>
              <select
                value={destinationCode}
                onChange={(e) => setDestinationCode(e.target.value)}
                disabled={submitting || marketplaces.length === 0}
                className="h-9 w-full px-2 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900"
              >
                {marketplaces.length === 0 ? (
                  <option value="IT">Loading…</option>
                ) : (
                  marketplaces.map((m) => (
                    <option key={m.code} value={m.code}>
                      {m.code} — {m.currency}{!m.isParticipating ? ' (not participating)' : ''}
                    </option>
                  ))
                )}
              </select>
            </Field>
          </div>

          {/* Items */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
                Items <span className="text-rose-600 dark:text-rose-400">*</span>
              </label>
              <button
                type="button"
                onClick={() => setItems((prev) => [...prev, makeRow()])}
                disabled={submitting}
                className="h-6 px-2 text-xs border border-slate-300 dark:border-slate-700 rounded inline-flex items-center gap-1 hover:border-blue-400"
              >
                <Plus size={10} /> Add item
              </button>
            </div>
            <div className="space-y-1.5">
              {items.map((it, idx) => (
                <ItemRow
                  key={it.rowId}
                  row={it}
                  index={idx}
                  disabled={submitting}
                  onChange={(next) =>
                    setItems((prev) => prev.map((r) => (r.rowId === it.rowId ? next : r)))
                  }
                  onRemove={
                    items.length > 1
                      ? () => setItems((prev) => prev.filter((r) => r.rowId !== it.rowId))
                      : undefined
                  }
                />
              ))}
            </div>
          </div>

          {/* Source address */}
          <div className="space-y-1.5">
            <label className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Source address (origin warehouse)
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <Field label="Contact name" required>
                <Input
                  value={src.name}
                  onChange={(v) => setSrc({ ...src, name: v })}
                  disabled={submitting}
                />
              </Field>
              <Field label="Company name">
                <Input
                  value={src.companyName}
                  onChange={(v) => setSrc({ ...src, companyName: v })}
                  disabled={submitting}
                />
              </Field>
              <Field label="Address line 1" required>
                <Input
                  value={src.addressLine1}
                  onChange={(v) => setSrc({ ...src, addressLine1: v })}
                  disabled={submitting}
                />
              </Field>
              <Field label="Address line 2">
                <Input
                  value={src.addressLine2}
                  onChange={(v) => setSrc({ ...src, addressLine2: v })}
                  disabled={submitting}
                />
              </Field>
              <Field label="City" required>
                <Input
                  value={src.city}
                  onChange={(v) => setSrc({ ...src, city: v })}
                  disabled={submitting}
                />
              </Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Province" required>
                  <Input
                    value={src.stateOrProvinceCode}
                    onChange={(v) => setSrc({ ...src, stateOrProvinceCode: v })}
                    disabled={submitting}
                  />
                </Field>
                <Field label="Postal" required>
                  <Input
                    value={src.postalCode}
                    onChange={(v) => setSrc({ ...src, postalCode: v })}
                    disabled={submitting}
                  />
                </Field>
                <Field label="Country" required>
                  <Input
                    value={src.countryCode}
                    onChange={(v) => setSrc({ ...src, countryCode: v.toUpperCase().slice(0, 2) })}
                    disabled={submitting}
                  />
                </Field>
              </div>
              <Field label="Phone (optional)">
                <Input
                  value={src.phoneNumber}
                  onChange={(v) => setSrc({ ...src, phoneNumber: v })}
                  disabled={submitting}
                />
              </Field>
              <Field label="Email (optional)">
                <Input
                  value={src.email}
                  onChange={(v) => setSrc({ ...src, email: v })}
                  disabled={submitting}
                />
              </Field>
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          disabled={submitting}
          className="h-9 px-3 text-sm border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="h-9 px-3 text-sm bg-blue-600 dark:bg-blue-700 text-white rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {submitting ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />}
          {submitting ? 'Creating plan…' : 'Create plan'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

// ── Helpers ────────────────────────────────────────────────────────────

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <label className="space-y-1 block">
      <span className="text-[11px] uppercase tracking-wider text-slate-500 dark:text-slate-400 font-medium">
        {label} {required && <span className="text-rose-600 dark:text-rose-400">*</span>}
      </span>
      {children}
    </label>
  )
}

function Input({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className="h-9 w-full px-2.5 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 disabled:opacity-60"
    />
  )
}

function ItemRow({
  row,
  index,
  disabled,
  onChange,
  onRemove,
}: {
  row: PlanItemRow
  index: number
  disabled?: boolean
  onChange: (next: PlanItemRow) => void
  onRemove?: () => void
}) {
  const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([])
  const [searching, setSearching] = useState(false)

  // Debounced product search when sku field is being typed (not after a pick).
  useEffect(() => {
    if (row.picked || !row.sku.trim() || row.sku.length < 2) {
      setSuggestions([])
      return
    }
    let cancelled = false
    const handle = setTimeout(async () => {
      setSearching(true)
      try {
        const url = `${getBackendUrl()}/api/products?search=${encodeURIComponent(row.sku.trim())}&limit=8`
        const res = await fetch(url, { credentials: 'include' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const j = await res.json()
        if (cancelled) return
        const rows: ProductSuggestion[] = (j.products ?? j.items ?? j.data ?? []).map((p: { id: string; sku: string; name?: string | null }) => ({
          id: p.id,
          sku: p.sku,
          name: p.name ?? null,
        }))
        setSuggestions(rows.slice(0, 8))
      } catch {
        if (!cancelled) setSuggestions([])
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [row.sku, row.picked])

  return (
    <div className="border border-default dark:border-slate-800 rounded p-2 bg-slate-50/40 dark:bg-slate-900/30">
      <div className="flex items-start gap-2">
        <span className="text-[11px] tabular-nums text-slate-500 dark:text-slate-400 pt-2 w-5 text-right">{index + 1}.</span>
        <div className="flex-1 relative">
          <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-tertiary dark:text-slate-500 pointer-events-none" />
            <input
              type="text"
              placeholder="SKU (start typing to search)"
              value={row.sku}
              onChange={(e) => onChange({ ...row, sku: e.target.value, picked: false, productName: null })}
              disabled={disabled}
              className="h-9 w-full pl-7 pr-2 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 font-mono disabled:opacity-60"
            />
          </div>
          {row.productName && row.picked && (
            <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
              {row.productName}
            </div>
          )}
          {/* Suggestion dropdown */}
          {suggestions.length > 0 && !row.picked && (
            <div className="absolute z-10 left-0 right-0 mt-0.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded shadow-md max-h-48 overflow-y-auto">
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onChange({ ...row, sku: s.sku, productName: s.name, picked: true })}
                  className="block w-full text-left px-2.5 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 border-b border-subtle dark:border-slate-800 last:border-0"
                >
                  <span className="font-mono text-xs">{s.sku}</span>
                  {s.name && <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{s.name}</span>}
                </button>
              ))}
              {searching && <div className="px-2.5 py-1.5 text-[11px] text-tertiary">Searching…</div>}
            </div>
          )}
        </div>
        <div className="w-24">
          <input
            type="number"
            min={1}
            value={row.quantity}
            onChange={(e) => onChange({ ...row, quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
            disabled={disabled}
            className="h-9 w-full px-2 text-sm border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-900 tabular-nums text-right disabled:opacity-60"
          />
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="h-9 w-9 inline-flex items-center justify-center text-tertiary dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-30"
            title="Remove item"
          >
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  )
}
