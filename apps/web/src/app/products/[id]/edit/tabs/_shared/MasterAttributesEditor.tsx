'use client'

// MA.2 — schema-driven master attribute editor. Replaces the blank
// key/value "Technical Attributes" bag: fetches the productType's attribute
// schema (MA.1 GET /master-schema) and renders typed, grouped, required-first,
// searchable fields bound to the SAME categoryAttributes bag — so the parent's
// existing flush/dirty machinery (patch.technical) is unchanged. Off-schema
// keys stay editable via the embedded TechAttrsEditor escape hatch.

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Search } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Input } from '@/components/ui/Input'
import TechAttrsEditor from './TechAttrsEditor'

interface MasterAttribute {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'boolean'
  required: boolean
  allowedValues?: string[]
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
  const [loading, setLoading] = useState(true)
  const [q, setQ] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`${getBackendUrl()}/api/products/${productId}/master-schema`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => {
        if (!cancelled) setSchema(d.attributes ?? [])
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

  const customEntries = useMemo(() => {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value)) if (!schemaKeys.has(k)) out[k] = value[k]
    return out
  }, [value, schemaKeys])

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
  const requiredMissing = (schema ?? []).filter((a) => a.required && !isFilled(value[a.key])).length

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
              {requiredMissing > 0 && <span className="ml-1 text-rose-500">· {requiredMissing} required missing</span>}
            </span>
          </div>
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
            const schemaPart: Record<string, unknown> = {}
            for (const k of Object.keys(value)) if (schemaKeys.has(k)) schemaPart[k] = value[k]
            onChange({ ...schemaPart, ...nextCustom })
          }}
          onRemoveKey={onRemoveKey}
        />
      </div>
    </div>
  )
}

function AttrField({ attr, value, onChange }: { attr: MasterAttribute; value: unknown; onChange: (v: unknown) => void }) {
  const v = value == null ? '' : String(value)
  const selectCls =
    'h-8 rounded border border-zinc-300 bg-white px-2 text-sm dark:border-zinc-700 dark:bg-zinc-900'
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
        <select value={v} onChange={(e) => onChange(e.target.value)} className={selectCls}>
          <option value="">—</option>
          {attr.allowedValues.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : attr.type === 'boolean' ? (
        <select
          value={v}
          onChange={(e) => onChange(e.target.value === '' ? '' : e.target.value === 'true')}
          className={selectCls}
        >
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      ) : (
        <Input
          type={attr.type === 'number' ? 'number' : 'text'}
          value={v}
          onChange={(e) => onChange(attr.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
          className="h-8 text-sm"
        />
      )}
    </div>
  )
}
