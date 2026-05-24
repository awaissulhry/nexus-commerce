'use client'

// EC.15 — MasterDivergenceBanner
//
// Detects when a cockpit field that was authored locally (source =
// Manual / AI / Sibling) diverges from the Product master, and
// prompts the operator to promote the cockpit value back UP to the
// master record so every other channel + future fetch sees the
// improvement. Closes the loop so the cockpit isn't a divergence
// factory.
//
// Tracked fields:
//   • title       → product.name
//   • description → product.description
//   • price       → product.basePrice
//
// Only fires when source ∈ {manual, ai, sibling} — when the source
// is already 'master', the values match by definition. 'translations'
// is excluded too (per-market localisations shouldn't overwrite the
// master copy).
//
// Per-field Apply toggle, single bulk "Update Master" button.
// Dismiss hides the banner for the current state — re-edits or
// component remounts will resurface it if divergence persists.

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, ArrowUp, X, GitMerge } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'
import { useFieldSourceContext } from '../field-source/FieldSourceProvider'
import type { FieldSource } from '../field-source/types'

const PROMOTABLE_SOURCES: ReadonlyArray<FieldSource> = ['manual', 'ai', 'sibling']

interface Props {
  productId: string
  marketplace: string
  /** Initial source+value used when the operator hasn't touched a
   *  field yet — needed for the read() call against the Field Source
   *  provider since each field key registers lazily on first
   *  interaction. */
  initial: {
    title: { source: FieldSource; value: string }
    description: { source: FieldSource; value: string }
    price: { source: FieldSource; value: string }
  }
  master: {
    name: string | null
    description: string | null
    basePrice: number | null
  }
}

type FieldKey = 'title' | 'description' | 'price'

interface Divergence {
  field: FieldKey
  source: FieldSource
  cockpitValue: string
  masterValue: string
}

function shorten(s: string, n = 50): string {
  if (s.length <= n) return s
  return s.slice(0, n - 1) + '…'
}

export default function MasterDivergenceBanner({
  productId, marketplace, initial, master,
}: Props) {
  const router = useRouter()
  const ctx = useFieldSourceContext()
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [keep, setKeep] = useState<Record<FieldKey, boolean>>({ title: true, description: true, price: true })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read the live field-source state for each tracked field.
  const titleState = ctx.read(`${marketplace}.title`, initial.title)
  const descState = ctx.read(`${marketplace}.description`, initial.description)
  const priceState = ctx.read(`${marketplace}.price`, initial.price)

  const divergences = useMemo<Divergence[]>(() => {
    const out: Divergence[] = []
    // Title
    if (
      PROMOTABLE_SOURCES.includes(titleState.source) &&
      titleState.value.trim().length > 0 &&
      titleState.value !== (master.name ?? '')
    ) {
      out.push({
        field: 'title',
        source: titleState.source,
        cockpitValue: titleState.value,
        masterValue: master.name ?? '',
      })
    }
    // Description
    if (
      PROMOTABLE_SOURCES.includes(descState.source) &&
      descState.value.trim().length > 0 &&
      descState.value !== (master.description ?? '')
    ) {
      out.push({
        field: 'description',
        source: descState.source,
        cockpitValue: descState.value,
        masterValue: master.description ?? '',
      })
    }
    // Price
    const cockpitPriceNum = priceState.value === '' ? null : parseFloat(priceState.value)
    if (
      PROMOTABLE_SOURCES.includes(priceState.source) &&
      Number.isFinite(cockpitPriceNum) &&
      cockpitPriceNum != null &&
      cockpitPriceNum !== master.basePrice
    ) {
      out.push({
        field: 'price',
        source: priceState.source,
        cockpitValue: priceState.value,
        masterValue: master.basePrice != null ? String(master.basePrice) : '',
      })
    }
    return out
  }, [titleState, descState, priceState, master])

  // Dismissal signature: re-shows if the cockpit values change.
  const signature = useMemo(
    () => divergences.map((d) => `${d.field}=${d.cockpitValue}`).join('|'),
    [divergences],
  )

  const keptCount = divergences.filter((d) => keep[d.field]).length

  const handlePromote = useCallback(async () => {
    if (saving || keptCount === 0) return
    setSaving(true)
    setError(null)
    try {
      const fields: Record<string, unknown> = {}
      for (const d of divergences) {
        if (!keep[d.field]) continue
        if (d.field === 'title') fields.name = d.cockpitValue
        if (d.field === 'description') fields.description = d.cockpitValue
        if (d.field === 'price') {
          const n = parseFloat(d.cockpitValue)
          if (Number.isFinite(n)) fields.basePrice = n
        }
      }
      const res = await fetch(`${getBackendUrl()}/api/ebay/cockpit/promote-to-master`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ productId, fields }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error ?? `HTTP ${res.status}`)
      }
      // Flip each promoted field's source back to 'master' so the
      // banner stops firing (cockpit now equals master).
      for (const d of divergences) {
        if (!keep[d.field]) continue
        ctx.applySwitch(`${marketplace}.${d.field}`, 'master', d.cockpitValue)
      }
      setDismissed(signature)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saving, keptCount, divergences, keep, productId, marketplace, ctx, signature, router])

  if (divergences.length === 0) return null
  if (dismissed === signature) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'rounded border px-3 py-2.5 space-y-2',
        'border-violet-200 dark:border-violet-800 bg-violet-50/70 dark:bg-violet-950/30',
      )}
    >
      <div className="flex items-start gap-2">
        <GitMerge className="w-4 h-4 text-violet-600 dark:text-violet-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-violet-900 dark:text-violet-200">
            {divergences.length === 1
              ? `${labelFor(divergences[0]!.field)} diverges from Master`
              : `${divergences.length} cockpit fields diverge from Master`}
          </div>
          <div className="text-[10.5px] text-violet-700/80 dark:text-violet-300/80 mt-0.5">
            Promote upward so every other channel sees the improvement.
            Master stays the source of truth.
          </div>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(signature)}
          className="p-1 text-violet-500 hover:text-violet-900 dark:hover:text-violet-200 rounded flex-shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="space-y-1 pl-6">
        {divergences.map((d) => (
          <label key={d.field} className="flex items-center gap-2 cursor-pointer text-[11px]">
            <input
              type="checkbox"
              checked={!!keep[d.field]}
              onChange={(e) => setKeep((k) => ({ ...k, [d.field]: e.target.checked }))}
              className="w-3 h-3"
            />
            <span className="font-medium text-violet-900 dark:text-violet-200 w-20 flex-shrink-0">
              {labelFor(d.field)}
            </span>
            <span className="text-slate-500 line-through font-mono truncate min-w-0 flex-1">
              {shorten(d.masterValue || '(empty)')}
            </span>
            <span className="text-violet-400">→</span>
            <span className="text-violet-900 dark:text-violet-200 font-mono truncate min-w-0 flex-1">
              {shorten(d.cockpitValue || '(empty)')}
            </span>
          </label>
        ))}
      </div>

      {error && (
        <div className="text-[11px] px-2 py-1 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <span className="text-[10.5px] text-violet-500 mr-auto">
          {keptCount === 0 ? 'Pick at least one field' : `Will update Master for ${keptCount} field${keptCount === 1 ? '' : 's'}`}
        </span>
        <button
          type="button"
          onClick={handlePromote}
          disabled={saving || keptCount === 0}
          className="px-3 py-1 text-xs font-medium rounded bg-violet-600 hover:bg-violet-700 text-white disabled:opacity-50 inline-flex items-center gap-1.5"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <ArrowUp className="w-3 h-3" />}
          {saving ? 'Updating…' : 'Update Master'}
        </button>
      </div>
    </div>
  )
}

function labelFor(field: FieldKey): string {
  if (field === 'title') return 'Title'
  if (field === 'description') return 'Description'
  return 'Price'
}
