'use client'

/**
 * PIM B.1 — Global tab on /products/[id]/edit.
 *
 * "Core truth" view for a product: en + it base content side-by-side,
 * identifiers, physical dims, technical attributes (categoryAttributes).
 *
 * Reads + writes via /api/products/:id/global which runs through the
 * A.1-A.4 attribute-resolver (synthesis fills gaps from legacy columns
 * so operators see real data immediately).
 *
 * Out of scope for B.1: inheritance visualization (channel-tab work,
 * B.2), reset-to-master (B.3), variant inheritance preview (B.4).
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Save, AlertCircle, GitFork } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import LocaleColumn, { type LocaleSlot } from './_shared/LocaleColumn'
import TechAttrsEditor from './_shared/TechAttrsEditor'

interface GlobalView {
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
  onDirtyChange?: (count: number) => void
}

export default function GlobalTab({ productId, onDirtyChange }: Props) {
  const { toast } = useToast()
  const [view, setView] = useState<GlobalView | null>(null)
  const [pristine, setPristine] = useState<GlobalView | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ── Fetch ───────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/products/${productId}/global`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return (await r.json()) as GlobalView
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

  // ── Save ────────────────────────────────────────────────────────
  const save = useCallback(async () => {
    if (!view || !pristine) return
    setSaving(true)
    try {
      // Build the patch — only include sections that diverged from pristine
      // to keep PATCH bodies small and avoid clobbering keys we didn't
      // intend to touch.
      const patch: Record<string, unknown> = {}
      if (JSON.stringify(view.locales.en) !== JSON.stringify(pristine.locales.en)) {
        patch.en = view.locales.en
      }
      if (JSON.stringify(view.locales.it) !== JSON.stringify(pristine.locales.it)) {
        patch.it = view.locales.it
      }
      if (JSON.stringify(view.identifiers) !== JSON.stringify(pristine.identifiers)) {
        patch.identifiers = view.identifiers
      }
      if (JSON.stringify(view.physical) !== JSON.stringify(pristine.physical)) {
        patch.physical = view.physical
      }
      if (JSON.stringify(view.technical) !== JSON.stringify(pristine.technical)) {
        patch.technical = view.technical
      }

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
      toast.success('Saved')
    } catch (err: any) {
      toast.error('Save failed', { description: err?.message ?? 'Unknown error' })
    } finally {
      setSaving(false)
    }
  }, [view, pristine, productId, toast])

  // ── Helpers for updating slices of state ────────────────────────
  const updateLocale = useCallback(
    (locale: 'en' | 'it', next: LocaleSlot) => {
      setView((v) => (v ? { ...v, locales: { ...v.locales, [locale]: next } } : v))
    },
    [],
  )
  const updateIdentifiers = useCallback(
    (partial: Partial<GlobalView['identifiers']>) => {
      setView((v) => (v ? { ...v, identifiers: { ...v.identifiers, ...partial } } : v))
    },
    [],
  )
  const updatePhysical = useCallback(
    (partial: Partial<GlobalView['physical']>) => {
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
      <div className="flex items-center justify-center py-16 text-zinc-500">
        <Loader2 className="w-5 h-5 animate-spin mr-2" />
        Loading global view…
      </div>
    )
  }
  if (error || !view) {
    return (
      <div className="flex items-center gap-2 p-4 rounded-md bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300">
        <AlertCircle className="w-4 h-4" />
        Failed to load: {error ?? 'unknown error'}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {view.isVariant && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs">
          <GitFork className="w-3.5 h-3.5" />
          This is a variant — values shown are merged from the parent product. Editing here
          overrides the parent for this variant.
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Content (Global)
            </h2>
            <p className="text-xs text-zinc-500">
              Per-locale title, description, bullets, keywords. Channel tabs inherit from here
              unless overridden.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {isDirty && (
              <span className="text-xs text-amber-600 dark:text-amber-400">unsaved changes</span>
            )}
            <Button onClick={save} disabled={!isDirty || saving} size="sm">
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : <Save className="w-3.5 h-3.5 mr-1.5" />}
              Save
            </Button>
          </div>
        </div>
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

      <Card>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">
          Identifiers
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <Labeled label="Brand">
            <Input
              value={view.identifiers.brand ?? ''}
              onChange={(e) => updateIdentifiers({ brand: e.target.value || null })}
            />
          </Labeled>
          <Labeled label="Manufacturer">
            <Input
              value={view.identifiers.manufacturer ?? ''}
              onChange={(e) => updateIdentifiers({ manufacturer: e.target.value || null })}
            />
          </Labeled>
          <Labeled label="GTIN">
            <Input
              value={view.identifiers.gtin ?? ''}
              onChange={(e) => updateIdentifiers({ gtin: e.target.value || null })}
            />
          </Labeled>
          <Labeled label="UPC">
            <Input
              value={view.identifiers.upc ?? ''}
              onChange={(e) => updateIdentifiers({ upc: e.target.value || null })}
            />
          </Labeled>
          <Labeled label="EAN">
            <Input
              value={view.identifiers.ean ?? ''}
              onChange={(e) => updateIdentifiers({ ean: e.target.value || null })}
            />
          </Labeled>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 mb-3">Physical</h2>
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

      <Card>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Technical attributes
          </h2>
          <p className="text-xs text-zinc-500">
            Free-form key/value pairs stored in <code className="font-mono">categoryAttributes</code>.
            Channel mappings pull from these (e.g. <code className="font-mono">material</code>{' '}
            → Amazon attribute <code className="font-mono">outer_material_type</code>).
          </p>
        </div>
        <TechAttrsEditor
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
