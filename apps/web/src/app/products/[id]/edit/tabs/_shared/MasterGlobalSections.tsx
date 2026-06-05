'use client'

/**
 * TC.1 — Locales / Physical / Technical sections absorbed from the
 * (now-deprecated) GlobalTab so MasterDataTab can present a single,
 * unified Master tab without duplicating the Identifiers section.
 *
 * Why a separate component instead of inlining into MasterDataTab:
 *   - The two data sources are different. MasterDataTab edits product
 *     columns via /api/products/bulk; this block edits the
 *     attribute-resolver synthesis via /api/products/:id/global. Mixing
 *     the state machines in one component would be a 1,200-LOC mess.
 *   - Keeps the GlobalTab → MasterDataTab merge a pure composition;
 *     if we ever want to split them again the seam stays clean.
 *
 * Registry coordination:
 *   - This block is a *sub-tab*; from the parent registry's view there
 *     is still only one "master" entry. MasterDataTab owns that
 *     registration and coordinates its own flush()/discard() with this
 *     block's flush()/discard() via the `onRegister` callback below.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, GitFork, Loader2 } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import LocaleColumn, { type LocaleSlot } from './LocaleColumn'
import MasterAttributesEditor from './MasterAttributesEditor'

export interface GlobalSectionsView {
  productId: string
  isVariant: boolean
  locales: { en: LocaleSlot; it: LocaleSlot }
  identifiers: {
    brand: string | null
    manufacturer: string | null
    gtin: string | null
    upc: string | null
    ean: string | null
  }
  physical: {
    weightValue: number | null
    weightUnit: string | null
    dimLength: number | null
    dimWidth: number | null
    dimHeight: number | null
    dimUnit: string | null
  }
  technical: Record<string, unknown>
}

interface Props {
  productId: string
  /** Reports dirty count back to MasterDataTab so it can roll up
   *  into the single "master" registry entry. */
  onDirtyChange?: (count: number) => void
  /** Registers this block's flush + discard handlers with MasterDataTab,
   *  which composes them into its own flush/discard before reporting
   *  to the parent dirty registry. */
  onRegister?: (handlers: {
    flush: () => Promise<void>
    discard: () => void
  }) => void
  /** Bumped by parent's "Discard" handler; mirrors MasterDataTab's
   *  discardSignal prop for legacy callers without a registry. */
  discardSignal?: number
}

export default function MasterGlobalSections({
  productId,
  onDirtyChange,
  onRegister,
  discardSignal,
}: Props) {
  const [view, setView] = useState<GlobalSectionsView | null>(null)
  const [pristine, setPristine] = useState<GlobalSectionsView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // ── Fetch ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/${productId}/global`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as GlobalSectionsView
      })
      .then((data) => {
        if (cancelled) return
        setView(data)
        setPristine(structuredClone(data))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err?.message ?? 'Failed to load')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId])

  // ── Dirty tracking ──────────────────────────────────────────────
  const isDirty = pristine !== null && view !== null && JSON.stringify(view) !== JSON.stringify(pristine)
  useEffect(() => {
    onDirtyChange?.(isDirty ? 1 : 0)
  }, [isDirty, onDirtyChange])

  // ── Flush + discard, exposed via refs so the registered handlers
  // always call the latest closure even though registration runs
  // once on mount. Mirrors MasterDataTab's pattern.
  const flush = useCallback(async () => {
    if (!view || !pristine) return
    if (!isDirty) return
    const patch: Record<string, unknown> = {}
    if (JSON.stringify(view.locales.en) !== JSON.stringify(pristine.locales.en)) {
      patch.en = view.locales.en
    }
    if (JSON.stringify(view.locales.it) !== JSON.stringify(pristine.locales.it)) {
      patch.it = view.locales.it
    }
    if (JSON.stringify(view.physical) !== JSON.stringify(pristine.physical)) {
      patch.physical = view.physical
    }
    if (JSON.stringify(view.technical) !== JSON.stringify(pristine.technical)) {
      patch.technical = view.technical
    }
    // Identifiers intentionally excluded — MasterDataTab owns those
    // and writes them through /api/products/bulk. Including them here
    // would double-write and could race.
    if (Object.keys(patch).length === 0) return
    const res = await fetch(`${getBackendUrl()}/api/products/${productId}/global`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patch }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? `HTTP ${res.status}`)
    }
    setPristine(structuredClone(view))
  }, [view, pristine, isDirty, productId])

  const flushRef = useRef<() => Promise<void>>(async () => {})
  flushRef.current = flush

  const discard = useCallback(() => {
    if (!pristine) return
    setView(structuredClone(pristine))
  }, [pristine])
  const discardRef = useRef<() => void>(() => {})
  discardRef.current = discard

  // Register once on mount — refs keep the registered functions
  // pointing at the latest closure.
  useEffect(() => {
    if (!onRegister) return
    onRegister({
      flush: () => flushRef.current(),
      discard: () => discardRef.current(),
    })
  }, [onRegister])

  // Legacy discardSignal path for callers without a registry.
  const discardSeen = useRef(discardSignal)
  useEffect(() => {
    if (discardSignal === undefined) return
    if (discardSignal === discardSeen.current) return
    discardSeen.current = discardSignal
    discard()
  }, [discardSignal, discard])

  // ── Helpers ─────────────────────────────────────────────────────
  const updateLocale = useCallback(
    (locale: 'en' | 'it', next: LocaleSlot) => {
      setView((v) => (v ? { ...v, locales: { ...v.locales, [locale]: next } } : v))
    },
    [],
  )
  const updatePhysical = useCallback(
    (partial: Partial<GlobalSectionsView['physical']>) => {
      setView((v) => (v ? { ...v, physical: { ...v.physical, ...partial } } : v))
    },
    [],
  )
  const updateTechnical = useCallback(
    (next: Record<string, unknown>) => {
      setView((v) => (v ? { ...v, technical: next } : v))
    },
    [],
  )
  const removeTechnicalKey = useCallback(
    async (key: string) => {
      // Best-effort server-side delete (keeps the JSONB clean). If
      // it fails, we still drop the key from local state and the
      // next PATCH will re-sync.
      try {
        await fetch(
          `${getBackendUrl()}/api/products/${productId}/global/technical/${encodeURIComponent(key)}`,
          { method: 'DELETE' },
        )
      } catch {
        /* fallthrough — local removal happens in TechAttrsEditor */
      }
    },
    [productId],
  )

  // ── Render ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center py-6 text-zinc-500 text-sm">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        Loading content…
      </div>
    )
  }
  if (error || !view) {
    return (
      <div className="flex items-center gap-2 p-3 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 text-sm">
        <AlertCircle className="w-4 h-4" />
        Failed to load content sections: {error ?? 'unknown error'}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {view.isVariant && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs">
          <GitFork className="w-3.5 h-3.5" />
          This is a variant — values shown are merged from the parent product. Editing here overrides the parent for this variant.
        </div>
      )}

      <Card
        title="Content"
        description="Per-locale title, description, bullets, keywords. Channel tabs inherit from here unless overridden."
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <LocaleColumn
            locale="en"
            label="English"
            value={view.locales.en}
            onChange={(next) => updateLocale('en', next)}
          />
          <LocaleColumn
            locale="it"
            label="Italiano"
            value={view.locales.it}
            onChange={(next) => updateLocale('it', next)}
          />
        </div>
      </Card>

      <Card title="Physical">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Labeled label="Weight">
            <div className="flex gap-1.5">
              <Input
                type="number"
                step="0.001"
                value={view.physical.weightValue ?? ''}
                onChange={(e) =>
                  updatePhysical({ weightValue: e.target.value === '' ? null : Number(e.target.value) })
                }
                className="flex-1"
              />
              <Input
                value={view.physical.weightUnit ?? ''}
                onChange={(e) => updatePhysical({ weightUnit: e.target.value || null })}
                placeholder="kg"
                className="w-16"
              />
            </div>
          </Labeled>
          <Labeled label="Length">
            <Input
              type="number"
              step="0.01"
              value={view.physical.dimLength ?? ''}
              onChange={(e) =>
                updatePhysical({ dimLength: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Labeled>
          <Labeled label="Width">
            <Input
              type="number"
              step="0.01"
              value={view.physical.dimWidth ?? ''}
              onChange={(e) =>
                updatePhysical({ dimWidth: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Labeled>
          <Labeled label="Height">
            <Input
              type="number"
              step="0.01"
              value={view.physical.dimHeight ?? ''}
              onChange={(e) =>
                updatePhysical({ dimHeight: e.target.value === '' ? null : Number(e.target.value) })
              }
            />
          </Labeled>
          <Labeled label="Dim unit">
            <Input
              value={view.physical.dimUnit ?? ''}
              onChange={(e) => updatePhysical({ dimUnit: e.target.value || null })}
              placeholder="cm"
            />
          </Labeled>
        </div>
      </Card>

      <Card
        title="Attributes"
        description="Category attributes for this product type. Channel mappings pull from these — fill them so listings publish complete."
      >
        <MasterAttributesEditor
          productId={productId}
          value={view.technical}
          onChange={updateTechnical}
          onRemoveKey={removeTechnicalKey}
        />
      </Card>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">{label}</label>
      {children}
    </div>
  )
}
