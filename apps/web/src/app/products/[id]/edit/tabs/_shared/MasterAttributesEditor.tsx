'use client'

// MA.2 — schema-driven master attribute editor. Replaces the blank
// key/value "Technical Attributes" bag: fetches the productType's attribute
// schema (MA.1 GET /master-schema) and renders typed, grouped, required-first,
// searchable fields bound to the SAME categoryAttributes bag — so the parent's
// existing flush/dirty machinery (patch.technical) is unchanged. Off-schema
// keys stay editable via the embedded TechAttrsEditor escape hatch.

import { useEffect, useMemo, useState } from 'react'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/components.css'
import { Loader2, Search, Sparkles } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import { Listbox } from '@/design-system/components/Listbox'
import TechAttrsEditor from './TechAttrsEditor'

interface MasterAttribute {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'boolean'
  required: boolean
  allowedValues?: string[]
  optionLabels?: Record<string, string>
  localizedByMarket?: Record<string, Record<string, string>>
  group: string
  helpText?: string
  source: 'schema' | 'mapping'
}

interface Props {
  productId: string
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  onRemoveKey?: (key: string) => void
}

function isFilled(v: unknown): boolean {
  return v !== undefined && v !== null && v !== ''
}

export default function MasterAttributesEditor({ productId, value, onChange, onRemoveKey }: Props) {
  const [schema, setSchema] = useState<MasterAttribute[] | null>(null)
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiSugg, setAiSugg] = useState<{ key: string; label: string; value: string; confidence: string; reason: string }[] | null>(null)
  const [aiAccept, setAiAccept] = useState<Set<string>>(new Set())
  const [aiErr, setAiErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/master-schema`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) {
          setSchema(d.attributes ?? [])
          setHiddenKeys(new Set<string>(d.hiddenKeys ?? []))
        }
      })
      .catch(() => {
        if (!cancelled) setSchema([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [productId])

  const schemaKeys = useMemo(() => new Set((schema ?? []).map((a) => a.key)), [schema])

  const setAttr = (key: string, v: unknown) => {
    const next = { ...value }
    if (!isFilled(v)) delete next[key]
    else next[key] = v
    onChange(next)
  }

  const runAiFill = async () => {
    setAiBusy(true)
    setAiErr(null)
    setAiSugg(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/products/${productId}/master/ai-fill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: '{}',
      })
      const json = await res.json()
      if (!res.ok) {
        setAiErr(json?.error ?? `HTTP ${res.status}`)
        return
      }
      const s = json.suggestions ?? []
      if (s.length === 0) {
        setAiErr(json.reason ?? 'No suggestions.')
        return
      }
      setAiSugg(s)
      setAiAccept(new Set(s.filter((x: { confidence: string }) => x.confidence === 'high').map((x: { key: string }) => x.key)))
    } catch (e) {
      setAiErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAiBusy(false)
    }
  }

  const applyAi = () => {
    if (!aiSugg) return
    const next = { ...value }
    for (const s of aiSugg) if (aiAccept.has(s.key)) next[s.key] = s.value
    onChange(next)
    setAiSugg(null)
  }

  // Off-schema keys the operator added — but NOT the Amazon plumbing keys
  // (hiddenKeys), which may sit in categoryAttributes yet aren't real
  // attributes (e.g. item_name holding the localized title).
  const customEntries = useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) if (!schemaKeys.has(k) && !hiddenKeys.has(k)) out[k] = value[k]
    return out
  }, [value, schemaKeys, hiddenKeys])

  const filtered = useMemo(() => {
    const s = schema ?? []
    const n = q.trim().toLowerCase()
    if (!n) return s
    return s.filter((a) => a.label.toLowerCase().includes(n) || a.key.toLowerCase().includes(n))
  }, [schema, q])

  const groups = useMemo(() => {
    const m = new Map<string, MasterAttribute[]>()
    for (const a of filtered) {
      const g = m.get(a.group) ?? []
      g.push(a)
      m.set(a.group, g)
    }
    return [...m.entries()]
  }, [filtered])

  const filledCount = (schema ?? []).filter((a) => isFilled(value[a.key])).length
  const missingRequired = (schema ?? []).filter((a) => a.required && !isFilled(value[a.key]))

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-zinc-500">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading attributes…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {(schema?.length ?? 0) > 0 && (
        <>
          <div className="flex items-center gap-2">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search attributes…" className="h-8 pl-7 text-xs" />
            </div>
            <span className="text-xs text-zinc-500">
              {filledCount}/{schema!.length} filled
              {missingRequired.length > 0 && <span className="ml-1 text-rose-500">· {missingRequired.length} required missing</span>}
            </span>
            <button
              type="button"
              onClick={runAiFill}
              disabled={aiBusy}
              title="Infer empty attributes from the title/description with AI"
              className="ml-auto inline-flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
            >
              {aiBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />} Suggest with AI
            </button>
          </div>
          {missingRequired.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 text-[11px]">
              <span className="text-rose-500">Required missing:</span>
              {missingRequired.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  onClick={() => setQ(a.label)}
                  title="Jump to this field"
                  className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-300"
                >
                  {a.label}
                </button>
              ))}
            </div>
          ) : (
            filledCount > 0 && <div className="text-[11px] text-emerald-600 dark:text-emerald-400">✓ All required attributes filled</div>
          )}
          {aiErr && <div className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">{aiErr}</div>}
          {aiSugg && aiSugg.length > 0 && (
            <div className="rounded border border-blue-200 bg-blue-50/40 p-2 dark:border-blue-900 dark:bg-blue-950/20">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-300">AI suggestions</span>
                <button
                  type="button"
                  onClick={applyAi}
                  disabled={aiAccept.size === 0}
                  className="rounded bg-blue-600 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  Apply {aiAccept.size}
                </button>
              </div>
              <div className="space-y-1">
                {aiSugg.map((s) => (
                  <label key={s.key} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={aiAccept.has(s.key)}
                      onChange={() =>
                        setAiAccept((prev) => {
                          const n = new Set(prev)
                          if (n.has(s.key)) n.delete(s.key)
                          else n.add(s.key)
                          return n
                        })
                      }
                    />
                    <span className="font-medium text-zinc-700 dark:text-zinc-300">{s.label}:</span>
                    <span className="text-zinc-600 dark:text-zinc-400">{s.value}</span>
                    <span
                      className={`rounded px-1 text-[9px] ${s.confidence === 'high' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'}`}
                    >
                      {s.confidence}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {groups.map(([group, attrs]) => (
            <div key={group} className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{group}</div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                {attrs.map((a) => (
                  <AttrField key={a.key} attr={a} value={value[a.key]} onChange={(v) => setAttr(a.key, v)} />
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      <div className="space-y-2 border-t border-zinc-100 pt-3 dark:border-zinc-800">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">Custom attributes</div>
        <TechAttrsEditor
          value={customEntries}
          onChange={(nextCustom) => {
            // Preserve schema values AND hidden plumbing keys (don't silently
            // drop them) while applying the custom-section edits.
            const preserved: Record<string, unknown> = {}
            for (const k of Object.keys(value)) if (schemaKeys.has(k) || hiddenKeys.has(k)) preserved[k] = value[k]
            onChange({ ...preserved, ...nextCustom })
          }}
          onRemoveKey={onRemoveKey}
        />
      </div>
    </div>
  )
}

function AttrField({ attr, value, onChange }: { attr: MasterAttribute; value: unknown; onChange: (v: unknown) => void }) {
  const v = value == null ? '' : String(value)
  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400" title={attr.helpText}>
        {attr.label}
        {attr.required && <span className="text-rose-500">*</span>}
        {attr.source === 'mapping' && (
          <span className="text-[9px] text-blue-500" title="referenced by a mapping rule">
            mapped
          </span>
        )}
      </label>
      {attr.type === 'select' && attr.allowedValues ? (
        <Listbox
          value={v}
          onChange={(next) => onChange(next)}
          ariaLabel={attr.label}
          className="w-full"
          options={[
            { value: '', label: '—' },
            ...attr.allowedValues.map((o) => ({ value: o, label: attr.optionLabels?.[o] ?? o })),
          ]}
        />
      ) : attr.type === 'boolean' ? (
        <Listbox
          value={v}
          onChange={(next) => onChange(next === '' ? '' : next === 'true')}
          ariaLabel={attr.label}
          className="w-full"
          options={[
            { value: '', label: '—' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
        />
      ) : (
        <Input
          type={attr.type === 'number' ? 'number' : 'text'}
          value={v}
          onChange={(e) => onChange(attr.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          className="h-8 text-sm"
        />
      )}
      {attr.type === 'select' && attr.localizedByMarket && value ? (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-zinc-400 dark:text-zinc-500" title="What each market displays for this value (Amazon auto-localizes)">
          {Object.entries(attr.localizedByMarket).map(([mkt, m]) => (
            <span key={mkt}>
              {mkt} → {m[String(value)] ?? String(value)}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}
