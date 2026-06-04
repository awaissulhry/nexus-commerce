'use client'

/**
 * FM.9 — value-map + size-scale manager.
 *
 * CRUD over the FM.4 catalog lookup tables that back the `valueMap` /
 * `sizeScale` transform ops:
 *   - Value maps: canonical → channel/market value (Rosso → Rot), per
 *     (channel, marketplace, attribute). Add / delete + an AI seed that
 *     maps a source market's enum values into each target market's schema.
 *   - Size scales: cross-system conversion (EU 52 → ALPHA L). List + add.
 *
 * Endpoints (all under /api): GET/PUT/DELETE /pim/value-maps,
 * POST /pim/value-maps/seed-ai, GET/PUT /pim/size-scales.
 */

import { useCallback, useEffect, useState } from 'react'
import { X, Loader2, Plus, Trash2, Sparkles, RefreshCw } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

interface ValueMap {
  id: string
  channel: string
  marketplace: string
  attribute: string
  fromValue: string
  toValue: string
  confidence: string
  reviewedAt: string | null
}
interface SizeScale {
  id: string
  scale: string
  fromSystem: string
  toSystem: string
  fromValue: string
  toValue: string
}

interface Props {
  open: boolean
  onClose: () => void
  channel: string
  code: string
}

export default function ValueMapManagerModal({ open, onClose, channel, code }: Props) {
  const { toast } = useToast()
  const [tab, setTab] = useState<'value' | 'size'>('value')
  const [valueMaps, setValueMaps] = useState<ValueMap[]>([])
  const [sizeScales, setSizeScales] = useState<SizeScale[]>([])
  const [loading, setLoading] = useState(false)
  const [attrFilter, setAttrFilter] = useState('')

  // add-row state
  const [vm, setVm] = useState({ attribute: '', fromValue: '', toValue: '', marketplace: code })
  const [ss, setSs] = useState({ scale: '', fromSystem: 'EU', toSystem: 'ALPHA', fromValue: '', toValue: '' })
  // AI seed state
  const [seed, setSeed] = useState({ attribute: '', productType: '', values: '', targetMarkets: 'DE,FR,ES,UK' })
  const [seeding, setSeeding] = useState(false)

  const fetchAll = useCallback(async () => {
    if (!open) return
    setLoading(true)
    try {
      const vmUrl = `${getBackendUrl()}/api/pim/value-maps?channel=${channel}${
        attrFilter.trim() ? `&attribute=${encodeURIComponent(attrFilter.trim())}` : ''
      }`
      const [vmRes, ssRes] = await Promise.all([
        fetch(vmUrl, { cache: 'no-store' }),
        fetch(`${getBackendUrl()}/api/pim/size-scales`, { cache: 'no-store' }),
      ])
      const vmData = vmRes.ok ? await vmRes.json() : { valueMaps: [] }
      const ssData = ssRes.ok ? await ssRes.json() : { sizeScales: [] }
      setValueMaps(vmData.valueMaps ?? [])
      setSizeScales(ssData.sizeScales ?? [])
    } catch (e: any) {
      toast.error('Failed to load lookups', { description: e?.message })
    } finally {
      setLoading(false)
    }
  }, [open, channel, attrFilter, toast])

  useEffect(() => {
    void fetchAll()
  }, [fetchAll])

  // reset the marketplace default when the active market changes
  useEffect(() => {
    setVm((s) => ({ ...s, marketplace: code }))
  }, [code])

  const addValueMap = useCallback(async () => {
    if (!vm.attribute.trim() || !vm.fromValue.trim() || !vm.toValue.trim()) return
    try {
      const r = await fetch(`${getBackendUrl()}/api/pim/value-maps`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, ...vm }),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`)
      toast.success(`Mapped ${vm.fromValue} → ${vm.toValue}`)
      setVm((s) => ({ ...s, fromValue: '', toValue: '' }))
      await fetchAll()
    } catch (e: any) {
      toast.error('Add failed', { description: e?.message })
    }
  }, [vm, channel, fetchAll, toast])

  const deleteValueMap = useCallback(
    async (id: string) => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/pim/value-maps/${id}`, { method: 'DELETE' })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        await fetchAll()
      } catch (e: any) {
        toast.error('Delete failed', { description: e?.message })
      }
    },
    [fetchAll, toast],
  )

  const addSizeScale = useCallback(async () => {
    if (!ss.scale.trim() || !ss.fromValue.trim() || !ss.toValue.trim()) return
    try {
      const r = await fetch(`${getBackendUrl()}/api/pim/size-scales`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ss),
      })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`)
      toast.success(`${ss.scale}: ${ss.fromValue} → ${ss.toValue}`)
      setSs((s) => ({ ...s, fromValue: '', toValue: '' }))
      await fetchAll()
    } catch (e: any) {
      toast.error('Add failed', { description: e?.message })
    }
  }, [ss, fetchAll, toast])

  const runSeed = useCallback(async () => {
    const values = seed.values.split(',').map((v) => v.trim()).filter(Boolean)
    const targetMarkets = seed.targetMarkets.split(',').map((v) => v.trim().toUpperCase()).filter(Boolean)
    if (!seed.attribute.trim() || !seed.productType.trim() || values.length === 0 || targetMarkets.length === 0) {
      toast.error('AI seed needs attribute, productType, values, and target markets')
      return
    }
    setSeeding(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/pim/value-maps/seed-ai`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketplace: code,
          attribute: seed.attribute.trim(),
          productType: seed.productType.trim().toUpperCase(),
          values,
          targetMarkets,
        }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(data?.error ?? `HTTP ${r.status}`)
      toast.success(`Seeded ${data.written ?? 0} value maps`, { description: 'Flagged for review (AI confidence)' })
      await fetchAll()
    } catch (e: any) {
      toast.error('AI seed failed', { description: e?.message })
    } finally {
      setSeeding(false)
    }
  }, [seed, code, fetchAll, toast])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-lg bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              Value maps &amp; size scales
            </h2>
            <span className="text-[11px] text-zinc-500 font-mono">{channel}/{code}</span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => void fetchAll()}
              className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
              aria-label="Refresh"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            </button>
            <button type="button" onClick={onClose} className="p-1 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* tabs */}
        <div className="flex border-b border-zinc-200 dark:border-zinc-800 text-xs">
          {(['value', 'size'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                'px-4 py-2 font-medium',
                tab === t
                  ? 'text-blue-600 border-b-2 border-blue-600'
                  : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
              )}
            >
              {t === 'value' ? `Value maps (${valueMaps.length})` : `Size scales (${sizeScales.length})`}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'value' ? (
            <div className="flex flex-col gap-3">
              {/* AI seed */}
              <div className="rounded border border-violet-200 dark:border-violet-900/50 bg-violet-50/50 dark:bg-violet-900/10 p-2">
                <div className="flex items-center gap-1.5 mb-1.5 text-[11px] font-medium text-violet-700 dark:text-violet-300">
                  <Sparkles className="w-3 h-3" /> AI seed — map a source market's values into each target market
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Input value={seed.attribute} onChange={(e) => setSeed({ ...seed, attribute: e.target.value })} placeholder="attribute (e.g. color)" className="text-[11px] font-mono" />
                  <Input value={seed.productType} onChange={(e) => setSeed({ ...seed, productType: e.target.value })} placeholder="productType (e.g. OUTERWEAR)" className="text-[11px] font-mono" />
                  <Input value={seed.values} onChange={(e) => setSeed({ ...seed, values: e.target.value })} placeholder="values, comma-sep (Rosso, Nero)" className="text-[11px]" />
                  <Input value={seed.targetMarkets} onChange={(e) => setSeed({ ...seed, targetMarkets: e.target.value })} placeholder="target markets (DE,FR,ES,UK)" className="text-[11px] font-mono" />
                </div>
                <button
                  type="button"
                  onClick={() => void runSeed()}
                  disabled={seeding}
                  className="mt-1.5 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-40"
                >
                  {seeding ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  Seed from {code}
                </button>
              </div>

              {/* add row */}
              <div className="flex items-end gap-1.5">
                <Input value={vm.attribute} onChange={(e) => setVm({ ...vm, attribute: e.target.value })} placeholder="attribute" className="text-[11px] font-mono" />
                <Input value={vm.fromValue} onChange={(e) => setVm({ ...vm, fromValue: e.target.value })} placeholder="from (Rosso)" className="text-[11px]" />
                <span className="text-zinc-400 pb-2">→</span>
                <Input value={vm.toValue} onChange={(e) => setVm({ ...vm, toValue: e.target.value })} placeholder="to (Rot)" className="text-[11px]" />
                <Input value={vm.marketplace} onChange={(e) => setVm({ ...vm, marketplace: e.target.value })} placeholder="market (* = all)" className="w-24 text-[11px] font-mono" />
                <button type="button" onClick={() => void addValueMap()} className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-700">
                  <Plus className="w-3 h-3" /> Add
                </button>
              </div>

              {/* filter + list */}
              <Input value={attrFilter} onChange={(e) => setAttrFilter(e.target.value)} placeholder="filter by attribute…" className="text-[11px]" />
              <div className="rounded border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {valueMaps.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-zinc-400 italic">No value maps yet.</div>
                ) : (
                  valueMaps.map((m) => (
                    <div key={m.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      <span className="font-mono text-zinc-500 w-24 truncate">{m.attribute}</span>
                      <span className="text-zinc-700 dark:text-zinc-300">{m.fromValue}</span>
                      <span className="text-zinc-400">→</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{m.toValue}</span>
                      <span className="font-mono text-[10px] text-zinc-400">{m.marketplace}</span>
                      {!m.reviewedAt && (
                        <span className="px-1 rounded text-[9px] bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300" title={`AI confidence: ${m.confidence}`}>
                          review
                        </span>
                      )}
                      <button type="button" onClick={() => void deleteValueMap(m.id)} className="ml-auto text-zinc-300 hover:text-red-600" aria-label="Delete">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* add size scale */}
              <div className="flex items-end gap-1.5 flex-wrap">
                <Input value={ss.scale} onChange={(e) => setSs({ ...ss, scale: e.target.value })} placeholder="scale (MENS_JACKET)" className="text-[11px] font-mono" />
                <Input value={ss.fromSystem} onChange={(e) => setSs({ ...ss, fromSystem: e.target.value })} placeholder="EU" className="w-16 text-[11px]" />
                <span className="text-zinc-400 pb-2">→</span>
                <Input value={ss.toSystem} onChange={(e) => setSs({ ...ss, toSystem: e.target.value })} placeholder="ALPHA" className="w-20 text-[11px]" />
                <Input value={ss.fromValue} onChange={(e) => setSs({ ...ss, fromValue: e.target.value })} placeholder="52" className="w-16 text-[11px]" />
                <span className="text-zinc-400 pb-2">→</span>
                <Input value={ss.toValue} onChange={(e) => setSs({ ...ss, toValue: e.target.value })} placeholder="XL" className="w-16 text-[11px]" />
                <button type="button" onClick={() => void addSizeScale()} className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] font-medium bg-blue-600 text-white hover:bg-blue-700">
                  <Plus className="w-3 h-3" /> Add
                </button>
              </div>
              <div className="rounded border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-100 dark:divide-zinc-800/60">
                {sizeScales.length === 0 ? (
                  <div className="px-3 py-6 text-center text-[11px] text-zinc-400 italic">No size scales yet.</div>
                ) : (
                  sizeScales.map((s) => (
                    <div key={s.id} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                      <span className="font-mono text-zinc-500 w-32 truncate">{s.scale}</span>
                      <span className="font-mono text-[10px] text-zinc-400">{s.fromSystem}→{s.toSystem}</span>
                      <span className="text-zinc-700 dark:text-zinc-300">{s.fromValue}</span>
                      <span className="text-zinc-400">→</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">{s.toValue}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
