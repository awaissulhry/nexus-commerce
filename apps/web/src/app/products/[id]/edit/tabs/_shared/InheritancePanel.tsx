'use client'

/**
 * PIM B.2 — Inheritance panel for a single channel listing.
 *
 * Mounts at the top of ChannelListingTab. For the 5 SSOT fields
 * (title, description, price, quantity, bulletPoints) renders the new
 * inheritance UX:
 *
 *   - Inherited: gray italic ghost of the master value. Click to
 *     reveal an input prefilled with the inherited value; first
 *     keystroke commits an override.
 *   - Overridden: bold value with "Reset to Global" inline action
 *     that hits POST /channel-listing/:clId/reset.
 *
 * Reads via GET /channel-listing/:clId/inheritance which runs through
 * the A.1-A.4 resolver so synthesis from legacy columns is visible.
 *
 * Coexists with the existing schema-driven ChannelFieldEditor below
 * it; both can edit the same fields independently. Phase B.3+ will
 * consolidate.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { cn } from '@/lib/utils'
import InheritanceAwareField from './InheritanceAwareField'

type SsotKey = 'title' | 'description' | 'price' | 'quantity' | 'bulletPoints'

interface FieldState {
  effective: unknown
  master: unknown
  isOverridden: boolean
  source: string | null
}

interface InheritanceView {
  productId: string
  channelListingId: string
  channel: string
  marketplace: string
  fields: Record<SsotKey, FieldState>
}

interface Props {
  productId: string
  channelListingId: string
  /** Display name shown in chips ("Amazon IT"). */
  targetLabel: string
  /** Bumped by parent when listing data changes externally (e.g. a
   *  channel pull). Forces a refetch. */
  refreshSignal?: number
  /** Notify parent when a write happens here so it can refresh its
   *  own state if needed (the existing ChannelFieldEditor mounts the
   *  same data — they don't share a store). */
  onAfterWrite?: () => void
}

export default function InheritancePanel({
  productId,
  channelListingId,
  targetLabel,
  refreshSignal = 0,
  onAfterWrite,
}: Props) {
  const { toast } = useToast()
  const [view, setView] = useState<InheritanceView | null>(null)
  const [loading, setLoading] = useState(true)
  const [resetting, setResetting] = useState<SsotKey | 'all' | null>(null)
  const [error, setError] = useState<string | null>(null)

  // ── Fetch ───────────────────────────────────────────────────────
  const fetchInheritance = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(
        `${getBackendUrl()}/api/products/${productId}/channel-listing/${channelListingId}/inheritance`,
        { cache: 'no-store' },
      )
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as InheritanceView
      setView(data)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [productId, channelListingId])

  useEffect(() => {
    void fetchInheritance()
  }, [fetchInheritance, refreshSignal])

  // ── Reset one field (or all) ────────────────────────────────────
  const handleReset = useCallback(
    async (field: SsotKey | 'all') => {
      setResetting(field)
      try {
        const r = await fetch(
          `${getBackendUrl()}/api/products/${productId}/channel-listing/${channelListingId}/reset`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ field }),
          },
        )
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body.error ?? `HTTP ${r.status}`)
        }
        toast.success(field === 'all' ? 'All overrides cleared' : `Reset ${field}`)
        await fetchInheritance()
        onAfterWrite?.()
      } catch (err: any) {
        toast.error('Reset failed', { description: err?.message ?? 'Unknown error' })
      } finally {
        setResetting(null)
      }
    },
    [productId, channelListingId, fetchInheritance, toast, onAfterWrite],
  )

  // ── Set an override ─────────────────────────────────────────────
  // Writes through the existing PATCH on /api/inventory/listing/:id
  // or a similar listing-update endpoint. For B.2 we use the legacy
  // ChannelListing update path (PATCH /api/marketplaces/listings/:id)
  // so we don't fork the write logic — the existing edit page already
  // mounts that. We only need to flip followMasterX=false + set the
  // override column.
  //
  // Endpoint chosen: PATCH /api/marketplaces/listings/:id (used by
  // ChannelFieldEditor) supports the same fields we need.
  const handleSetOverride = useCallback(
    async (field: SsotKey, rawValue: string) => {
      const body: Record<string, unknown> = {}
      const followFlag = {
        title: 'followMasterTitle',
        description: 'followMasterDescription',
        price: 'followMasterPrice',
        quantity: 'followMasterQuantity',
        bulletPoints: 'followMasterBulletPoints',
      }[field]
      const overrideCol = {
        title: 'titleOverride',
        description: 'descriptionOverride',
        price: 'priceOverride',
        quantity: 'quantityOverride',
        bulletPoints: 'bulletPointsOverride',
      }[field]

      body[followFlag] = false
      if (field === 'price') {
        body[overrideCol] = rawValue === '' ? null : Number(rawValue)
      } else if (field === 'quantity') {
        body[overrideCol] = rawValue === '' ? null : Math.trunc(Number(rawValue))
      } else if (field === 'bulletPoints') {
        // bulletPoints comes through as newline-separated text in this
        // simplified panel; ChannelFieldEditor handles the rich case.
        body[overrideCol] = rawValue
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      } else {
        body[overrideCol] = rawValue
      }

      try {
        const r = await fetch(
          `${getBackendUrl()}/api/marketplaces/listings/${channelListingId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          },
        )
        if (!r.ok) {
          const errBody = await r.json().catch(() => ({}))
          throw new Error(errBody.error ?? `HTTP ${r.status}`)
        }
        await fetchInheritance()
        onAfterWrite?.()
      } catch (err: any) {
        toast.error('Save failed', { description: err?.message ?? 'Unknown error' })
      }
    },
    [channelListingId, fetchInheritance, toast, onAfterWrite],
  )

  // ── Render ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <Card>
        <div className="flex items-center justify-center py-6 text-zinc-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin mr-2" />
          Loading inheritance…
        </div>
      </Card>
    )
  }
  if (error || !view) {
    return null // fall back silently; ChannelFieldEditor below still works
  }

  const overridenCount = Object.values(view.fields).filter((f) => f.isOverridden).length

  return (
    <Card>
      <div className="px-4 py-3 border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Inheritance ({targetLabel})
          </h3>
          <p className="text-xs text-zinc-500 mt-0.5">
            {overridenCount === 0
              ? 'All fields inherit from Global. Click a field to override.'
              : `${overridenCount} field${overridenCount === 1 ? '' : 's'} overridden on this marketplace.`}
          </p>
        </div>
        {overridenCount > 0 && (
          <button
            type="button"
            onClick={() => void handleReset('all')}
            disabled={resetting === 'all'}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <RefreshCw className={cn('w-3 h-3', resetting === 'all' && 'animate-spin')} />
            Reset all
          </button>
        )}
      </div>
      <div className="px-4 py-4 flex flex-col gap-4">
        <InheritanceAwareField
          label="Title"
          effectiveValue={(view.fields.title.effective as string | null) ?? ''}
          isOverridden={view.fields.title.isOverridden}
          targetLabel={targetLabel}
          onSetOverride={(v) => void handleSetOverride('title', v)}
          onReset={() => void handleReset('title')}
          renderInput={({ value, onChange, isOverridden, autoFocus }) => (
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoFocus={autoFocus}
              className={isOverridden ? 'font-medium' : ''}
            />
          )}
        />
        <InheritanceAwareField
          label="Description"
          effectiveValue={(view.fields.description.effective as string | null) ?? ''}
          isOverridden={view.fields.description.isOverridden}
          targetLabel={targetLabel}
          onSetOverride={(v) => void handleSetOverride('description', v)}
          onReset={() => void handleReset('description')}
          renderInput={({ value, onChange, isOverridden, autoFocus }) => (
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoFocus={autoFocus}
              rows={5}
              className={cn(
                'w-full px-3 py-2 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500',
                isOverridden && 'font-medium',
              )}
            />
          )}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <InheritanceAwareField
            label="Price"
            effectiveValue={
              view.fields.price.effective == null ? '' : String(view.fields.price.effective)
            }
            isOverridden={view.fields.price.isOverridden}
            targetLabel={targetLabel}
            onSetOverride={(v) => void handleSetOverride('price', v)}
            onReset={() => void handleReset('price')}
            renderInput={({ value, onChange, isOverridden, autoFocus }) => (
              <Input
                type="number"
                step="0.01"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                autoFocus={autoFocus}
                className={isOverridden ? 'font-medium' : ''}
              />
            )}
          />
          <InheritanceAwareField
            label="Quantity"
            effectiveValue={
              view.fields.quantity.effective == null ? '' : String(view.fields.quantity.effective)
            }
            isOverridden={view.fields.quantity.isOverridden}
            targetLabel={targetLabel}
            onSetOverride={(v) => void handleSetOverride('quantity', v)}
            onReset={() => void handleReset('quantity')}
            renderInput={({ value, onChange, isOverridden, autoFocus }) => (
              <Input
                type="number"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                autoFocus={autoFocus}
                className={isOverridden ? 'font-medium' : ''}
              />
            )}
          />
        </div>
        <InheritanceAwareField
          label="Bullet points"
          effectiveValue={
            Array.isArray(view.fields.bulletPoints.effective)
              ? (view.fields.bulletPoints.effective as string[]).join('\n')
              : ''
          }
          isOverridden={view.fields.bulletPoints.isOverridden}
          targetLabel={targetLabel}
          onSetOverride={(v) => void handleSetOverride('bulletPoints', v)}
          onReset={() => void handleReset('bulletPoints')}
          renderInput={({ value, onChange, isOverridden, autoFocus }) => (
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              autoFocus={autoFocus}
              rows={4}
              placeholder="One bullet per line"
              className={cn(
                'w-full px-3 py-2 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500',
                isOverridden && 'font-medium',
              )}
            />
          )}
        />
      </div>
    </Card>
  )
}
