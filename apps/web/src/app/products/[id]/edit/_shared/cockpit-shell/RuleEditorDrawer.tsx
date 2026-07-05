'use client'

// Author a catalog mapping rule directly from the product Mapping tab.
//
// Rules are CATALOG-level — keyed by (channel, marketplace, productType) in
// Marketplace.schemaMapping. Editing here writes the productType overlay (or
// the channel·market default bucket when the product has no productType), so
// it also governs sibling products of the same type. The scope banner makes
// that explicit. Reuses the FM.9 GET/PUT/DELETE + TransformsEditor + FM.13
// mapping-suggest; every save is auto-versioned (MappingRevision).

import { useCallback, useEffect, useMemo, useState } from 'react'
import { X, Loader2, Trash2, Sparkles, Layers } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import TransformsEditor, { type TransformOp } from '@/app/settings/mappings/_shared/TransformsEditor'
import { Listbox } from '@/design-system/components/Listbox'

interface FieldRow {
  fieldKey: string
  label: string
  maxLength: number | null
  required: boolean
  allowedValues: unknown
  notes: string | null
  rule: { source?: string; fallback?: unknown; transforms?: TransformOp[]; required?: boolean; notes?: string } | null
}
interface Suggestion {
  fieldKey: string
  suggestedSource: string
  confidence: string
  reason: string
}
interface Coordinate {
  channel: string
  marketplace: string
}

interface Props {
  productType?: string | null
  /** All coordinates this product is listed on (for add-mode picker). */
  coordinates: Coordinate[]
  /** When set → edit mode (coord + field fixed). Omit → add mode. */
  initial?: { channel: string; marketplace: string; fieldKey: string }
  open: boolean
  onClose: () => void
  onSaved: () => void
}

interface Draft {
  source: string
  transforms: TransformOp[]
  fallback: string
  required: boolean
  notes: string
}

const EMPTY_DRAFT: Draft = { source: '', transforms: [], fallback: '', required: false, notes: '' }

export default function RuleEditorDrawer({
  productType,
  coordinates,
  initial,
  open,
  onClose,
  onSaved,
}: Props) {
  const editMode = !!initial
  const [coord, setCoord] = useState<Coordinate | null>(null)
  const [fieldKey, setFieldKey] = useState<string>('')
  const [fields, setFields] = useState<FieldRow[]>([])
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  // Seed coord + field from props each time the drawer opens.
  useEffect(() => {
    if (!open) return
    if (initial) {
      setCoord({ channel: initial.channel, marketplace: initial.marketplace })
      setFieldKey(initial.fieldKey)
    } else {
      setCoord(coordinates[0] ?? null)
      setFieldKey('')
    }
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Load the marketplace mapping (rules + field catalog) + suggestions for
  // the selected coordinate.
  useEffect(() => {
    if (!open || !coord) return
    let alive = true
    setLoading(true)
    const qs = productType ? `?productType=${encodeURIComponent(productType)}` : ''
    ;(async () => {
      try {
        const base = `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}`
        const [mRes, sRes] = await Promise.all([
          fetch(`${base}${qs}`, { credentials: 'include' }),
          fetch(`${base}/suggest${qs}`, { credentials: 'include' }).catch(() => null),
        ])
        const mJson = await mRes.json()
        if (!alive) return
        if (!mRes.ok) {
          setError(mJson?.error ?? `HTTP ${mRes.status}`)
          setFields([])
        } else {
          setFields((mJson.fields ?? []) as FieldRow[])
        }
        if (sRes && sRes.ok) {
          const sJson = await sRes.json()
          if (alive) setSuggestions((sJson.suggestions ?? []) as Suggestion[])
        } else {
          setSuggestions([])
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, coord, productType, reloadKey])

  const activeField = useMemo(() => fields.find((f) => f.fieldKey === fieldKey) ?? null, [fields, fieldKey])
  const suggestion = useMemo(
    () => suggestions.find((s) => s.fieldKey === fieldKey)?.suggestedSource ?? null,
    [suggestions, fieldKey],
  )
  const unmappedFields = useMemo(() => fields.filter((f) => !f.rule), [fields])
  const suggestFor = useCallback(
    (fk: string) => suggestions.find((s) => s.fieldKey === fk)?.suggestedSource ?? null,
    [suggestions],
  )

  // Seed the draft from the selected field's rule (edit) or empty + a
  // suggested source (add).
  useEffect(() => {
    if (!fieldKey) {
      setDraft(EMPTY_DRAFT)
      return
    }
    const r = activeField?.rule
    if (r) {
      setDraft({
        source: r.source ?? '',
        transforms: Array.isArray(r.transforms) ? r.transforms : [],
        fallback: r.fallback != null ? String(r.fallback) : '',
        required: !!r.required,
        notes: r.notes ?? '',
      })
    } else {
      setDraft({ ...EMPTY_DRAFT, source: suggestion ?? '' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, activeField])

  const save = useCallback(async () => {
    if (!coord || !fieldKey || !draft.source.trim()) {
      setError('A field and a source attribute are required.')
      return
    }
    setSaving(true)
    setError(null)
    const qs = productType ? `?productType=${encodeURIComponent(productType)}` : ''
    const body: Record<string, unknown> = { source: draft.source.trim(), required: draft.required }
    if (draft.fallback.trim()) body.fallback = draft.fallback.trim()
    if (draft.transforms.length) body.transforms = draft.transforms
    if (draft.notes.trim()) body.notes = draft.notes.trim()
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}/${encodeURIComponent(fieldKey)}${qs}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        const details = Array.isArray(json?.details) ? ` — ${json.details.join('; ')}` : ''
        setError((json?.error ?? `HTTP ${res.status}`) + details)
        return
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [coord, fieldKey, draft, productType, onSaved, onClose])

  const remove = useCallback(async () => {
    if (!coord || !fieldKey) return
    setSaving(true)
    setError(null)
    const qs = productType ? `?productType=${encodeURIComponent(productType)}` : ''
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}/${encodeURIComponent(fieldKey)}${qs}`,
        { method: 'DELETE', credentials: 'include' },
      )
      if (!res.ok) {
        const json = await res.json().catch(() => ({}))
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      onSaved()
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [coord, fieldKey, productType, onSaved, onClose])

  // Seed the channel's field catalog (ChannelSchema) in place when a
  // coordinate has none yet — so rules can be authored without leaving the
  // tab. eBay/Shopify seed a built-in schema; Amazon pulls SP-API per
  // productType.
  const syncSchema = useCallback(async () => {
    if (!coord) return
    setSyncing(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/pim/mappings/${coord.channel}/${coord.marketplace}/sync-schema`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(productType ? { productType } : {}),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`)
        return
      }
      setReloadKey((k) => k + 1) // re-fetch the field catalog
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }, [coord, productType])

  if (!open) return null

  const scopeLabel = productType
    ? `applies to all ${productType}`
    : `applies to all products on ${coord?.channel}·${coord?.marketplace}`
  const allowed = Array.isArray(activeField?.allowedValues) ? (activeField!.allowedValues as unknown[]) : null

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/40" onClick={() => !saving && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Mapping rule editor"
        className="flex h-full w-full max-w-md flex-col border-l border-default bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3 dark:border-slate-800">
          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            {editMode ? 'Edit mapping rule' : 'Add mapping rule'}
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* scope banner */}
        <div className="flex items-start gap-2 border-b border-amber-100 bg-amber-50 px-4 py-2 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
          <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Catalog rule {fieldKey && <>for <span className="font-mono">{fieldKey}</span></>}
            {coord && <> on {coord.channel}·{coord.marketplace}</>} — <strong>{scopeLabel}</strong>.
          </span>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {/* add-mode pickers */}
          {!editMode && (
            <>
              <Labeled label="Coordinate">
                <Listbox
                  value={coord ? `${coord.channel}:${coord.marketplace}` : ''}
                  onChange={(v) => {
                    const [channel, marketplace] = v.split(':')
                    setCoord({ channel, marketplace })
                    setFieldKey('')
                  }}
                  ariaLabel="Coordinate"
                  className="w-full"
                  options={coordinates.map((c) => ({ value: `${c.channel}:${c.marketplace}`, label: `${c.channel} · ${c.marketplace}` }))}
                />
              </Labeled>
              <Labeled label="Field (unmapped)">
                <Listbox
                  value={fieldKey}
                  onChange={(v) => setFieldKey(v)}
                  ariaLabel="Field (unmapped)"
                  className="w-full"
                  options={[
                    { value: '', label: 'Select a field…' },
                    // Operators read English — show the English fieldKey (matches
                    // the matrix), not the marketplace-localized label.
                    ...unmappedFields.map((f) => ({
                      value: f.fieldKey,
                      label: `${f.fieldKey}${suggestFor(f.fieldKey) ? ` → ${suggestFor(f.fieldKey)}` : ''}`,
                    })),
                  ]}
                />
              </Labeled>
              {!loading && coord && fields.length === 0 && (
                <div className="rounded border border-dashed border-slate-300 p-3 text-center text-xs text-slate-500 dark:border-slate-700">
                  No fields for {coord.channel}·{coord.marketplace} yet — its channel schema isn&apos;t synced.
                  <button
                    type="button"
                    onClick={syncSchema}
                    disabled={syncing}
                    className="mt-2 inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {syncing ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                    {syncing ? 'Syncing…' : `Sync ${coord.channel} schema`}
                  </button>
                </div>
              )}
              {!loading && coord && fields.length > 0 && unmappedFields.length === 0 && (
                <div className="text-xs text-tertiary">
                  Every field on this coordinate already has a rule — edit them from the matrix cells.
                </div>
              )}
            </>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
            </div>
          )}

          {fieldKey && (
            <>
              <Labeled label="Source — master attribute">
                <div className="flex items-center gap-2">
                  <input
                    value={draft.source}
                    onChange={(e) => setDraft((d) => ({ ...d, source: e.target.value }))}
                    placeholder="e.g. title, categoryAttributes.material"
                    className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 font-mono text-sm dark:border-slate-700 dark:bg-slate-900"
                  />
                  {suggestion && suggestion !== draft.source && (
                    <button
                      type="button"
                      onClick={() => setDraft((d) => ({ ...d, source: suggestion }))}
                      title={`Use suggested source: ${suggestion}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1.5 text-xs text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
                    >
                      <Sparkles className="h-3 w-3" /> {suggestion}
                    </button>
                  )}
                </div>
                {(activeField?.maxLength || allowed) && (
                  <div className="mt-1 text-[10.5px] text-tertiary">
                    {activeField?.maxLength ? `max ${activeField.maxLength} chars` : ''}
                    {allowed ? `${activeField?.maxLength ? ' · ' : ''}allowed: ${allowed.slice(0, 8).join(', ')}${allowed.length > 8 ? '…' : ''}` : ''}
                  </div>
                )}
              </Labeled>

              <Labeled label="Transforms">
                <TransformsEditor value={draft.transforms} onChange={(t) => setDraft((d) => ({ ...d, transforms: t }))} />
              </Labeled>

              <Labeled label="Fallback (optional)">
                <input
                  value={draft.fallback}
                  onChange={(e) => setDraft((d) => ({ ...d, fallback: e.target.value }))}
                  placeholder="value or attribute used when source is empty"
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </Labeled>

              <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                <input type="checkbox" checked={draft.required} onChange={(e) => setDraft((d) => ({ ...d, required: e.target.checked }))} />
                Required (blocks publish if empty)
              </label>

              <Labeled label="Notes (optional)">
                <textarea
                  value={draft.notes}
                  onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                  rows={2}
                  className="w-full rounded border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
              </Labeled>
            </>
          )}

          {error && (
            <div className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{error}</div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-subtle px-4 py-3 dark:border-slate-800">
          {editMode && activeField?.rule ? (
            <button
              type="button"
              onClick={remove}
              disabled={saving}
              className="inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:text-rose-400 dark:hover:bg-rose-950/30"
            >
              <Trash2 className="h-3.5 w-3.5" /> Remove
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} disabled={saving} className="rounded border border-default px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving || !fieldKey || !draft.source.trim()}
              className="inline-flex items-center gap-1.5 rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
              Save rule
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      {children}
    </div>
  )
}
