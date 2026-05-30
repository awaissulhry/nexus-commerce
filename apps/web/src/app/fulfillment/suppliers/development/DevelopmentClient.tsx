'use client'

// PD.5 — new-product development board (R&D pipeline). Project list with
// status, create, and a detail drawer with candidate suppliers (sourcing
// scaffolding for PD.6). Reached via an in-page tab from /fulfillment/
// suppliers — no new sidebar link.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { getBackendUrl } from '@/lib/backend-url'

const API = getBackendUrl()

const STATUSES = ['CONCEPT', 'SOURCING', 'SAMPLING', 'QUOTING', 'PRE_PRODUCTION', 'APPROVED', 'LAUNCHED', 'DROPPED', 'ON_HOLD'] as const

const STATUS_TONE: Record<string, string> = {
  CONCEPT: 'bg-slate-700 text-slate-200',
  SOURCING: 'bg-blue-900/60 text-blue-200',
  SAMPLING: 'bg-violet-900/60 text-violet-200',
  QUOTING: 'bg-cyan-900/60 text-cyan-200',
  PRE_PRODUCTION: 'bg-amber-900/60 text-amber-200',
  APPROVED: 'bg-emerald-900/60 text-emerald-200',
  LAUNCHED: 'bg-emerald-600 text-white',
  DROPPED: 'bg-rose-950/60 text-rose-300',
  ON_HOLD: 'bg-slate-800 text-slate-400',
}

type Project = {
  id: string
  code: string
  name: string
  status: string
  productType: string | null
  brief: string | null
  targetCostCents: number | null
  targetLaunchDate: string | null
  linkedProductId: string | null
  _count?: { candidates: number }
}

function eur(cents: number | null): string {
  return cents == null ? '—' : `€${(cents / 100).toFixed(2)}`
}

export default function DevelopmentClient() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [productType, setProductType] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/fulfillment/development/projects`, { cache: 'no-store' })
      if (res.ok) setProjects((await res.json()).items ?? [])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    if (!name.trim()) return
    setCreating(true)
    try {
      const res = await fetch(`${API}/api/fulfillment/development/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), productType: productType.trim() || undefined }),
      })
      if (res.ok) { setName(''); setProductType(''); const p = await res.json(); void load(); setOpenId(p.id) }
    } finally { setCreating(false) }
  }
  const setStatus = async (id: string, status: string) => {
    await fetch(`${API}/api/fulfillment/development/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
    void load()
  }

  return (
    <div className="space-y-3 text-slate-200">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/fulfillment/suppliers" className="text-xs text-slate-400 hover:text-slate-200">← Suppliers</Link>
          <h1 className="text-sm font-semibold">Product Development</h1>
        </div>
        <span className="text-[11px] text-slate-500">{projects.length} project{projects.length === 1 ? '' : 's'}</span>
      </div>

      {/* Create */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project name (e.g. Adventure helmet 2027)" className="w-72 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 focus:outline-none" />
        <input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="Product type (Helmet…)" className="w-44 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100 focus:outline-none" />
        <button onClick={create} disabled={creating || !name.trim()} className="rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">New project</button>
      </div>

      {/* List */}
      <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-900/40">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2">Project</th>
              <th className="px-2 py-2">Status</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2 text-right">Target cost</th>
              <th className="px-2 py-2 text-center">Suppliers</th>
              <th className="px-2 py-2">Launch</th>
              <th className="px-2 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">Loading…</td></tr>
            ) : projects.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-500">No projects yet. Start one above.</td></tr>
            ) : projects.map((p) => (
              <tr key={p.id} className="border-b border-slate-800 hover:bg-slate-800/40">
                <td className="px-3 py-2">
                  <button onClick={() => setOpenId(p.id)} className="text-left">
                    <div className="font-medium text-slate-200">{p.name}</div>
                    <div className="font-mono text-[10px] text-slate-500">{p.code}</div>
                  </button>
                </td>
                <td className="px-2 py-2">
                  <select value={p.status} onChange={(e) => setStatus(p.id, e.target.value)} className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_TONE[p.status] ?? 'bg-slate-700'}`}>
                    {STATUSES.map((s) => <option key={s} value={s} className="bg-slate-900 text-slate-200">{s.replace(/_/g, ' ')}</option>)}
                  </select>
                </td>
                <td className="px-2 py-2 text-slate-400">{p.productType ?? '—'}</td>
                <td className="px-2 py-2 text-right tabular-nums">{eur(p.targetCostCents)}</td>
                <td className="px-2 py-2 text-center">{p._count?.candidates ?? 0}</td>
                <td className="px-2 py-2 text-slate-400">{p.targetLaunchDate ? new Date(p.targetLaunchDate).toLocaleDateString() : '—'}</td>
                <td className="px-2 py-2 text-right"><button onClick={() => setOpenId(p.id)} className="text-blue-400 hover:underline">Open →</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {openId && <ProjectDrawer id={openId} onClose={() => { setOpenId(null); void load() }} />}
    </div>
  )
}

type Candidate = {
  id: string
  supplierId: string
  quotedCostCents: number | null
  sampleStatus: string | null
  isSelected: boolean
  notes: string | null
  supplier: { id: string; name: string; leadTimeDays: number; defaultCurrency: string | null }
}
type DevAttachment = { id: string; kind: string; url: string; filename: string | null; uploadedAt: string }
type ProjectDetail = Project & { candidates: Candidate[]; attachments: DevAttachment[] }

function ProjectDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const [p, setP] = useState<ProjectDetail | null>(null)
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])
  const [addId, setAddId] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`${API}/api/fulfillment/development/projects/${id}`, { cache: 'no-store' })
    if (res.ok) setP(await res.json())
  }, [id])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    void (async () => {
      const res = await fetch(`${API}/api/fulfillment/suppliers`, { cache: 'no-store' })
      if (res.ok) setSuppliers((await res.json()).items ?? [])
    })()
  }, [])

  const patchProject = async (b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/development/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); void load() }
  const addCandidate = async () => { if (!addId) return; await fetch(`${API}/api/fulfillment/development/projects/${id}/candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierId: addId }) }); setAddId(''); void load() }
  const patchCandidate = async (cid: string, b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/development/projects/${id}/candidates/${cid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); void load() }
  const delCandidate = async (cid: string) => { await fetch(`${API}/api/fulfillment/development/projects/${id}/candidates/${cid}`, { method: 'DELETE' }); void load() }

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-xl overflow-y-auto bg-slate-900 text-slate-200 shadow-2xl">
        {!p ? <div className="p-5 text-slate-500">Loading…</div> : (
          <div className="space-y-4 p-5">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold">{p.name}</div>
                <div className="font-mono text-[11px] text-slate-500">{p.code}</div>
              </div>
              <button onClick={onClose} className="text-slate-400 hover:text-slate-200">✕</button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Status</span>
                <select defaultValue={p.status} onChange={(e) => patchProject({ status: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100">
                  {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Target cost (€)</span>
                <input type="number" step="0.01" defaultValue={p.targetCostCents != null ? (p.targetCostCents / 100).toFixed(2) : ''} onBlur={(e) => patchProject({ targetCostEur: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Product type</span>
                <input defaultValue={p.productType ?? ''} onBlur={(e) => patchProject({ productType: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
              </label>
              <label className="block">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Target launch</span>
                <input type="date" defaultValue={p.targetLaunchDate ? p.targetLaunchDate.slice(0, 10) : ''} onBlur={(e) => patchProject({ targetLaunchDate: e.target.value })} className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-100" />
              </label>
            </div>

            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">Brief</span>
              <textarea defaultValue={p.brief ?? ''} rows={3} onBlur={(e) => patchProject({ brief: e.target.value })} placeholder="What are we developing, target specs, references…" className="mt-0.5 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100" />
            </label>

            {/* Candidate suppliers */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Candidate suppliers (sourcing)</span>
                <div className="flex items-center gap-1.5">
                  <select value={addId} onChange={(e) => setAddId(e.target.value)} className="rounded border border-slate-700 bg-slate-950 px-1.5 py-0.5 text-[11px] text-slate-100">
                    <option value="">+ add supplier…</option>
                    {suppliers.filter((s) => !p.candidates.some((c) => c.supplierId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <button onClick={addCandidate} disabled={!addId} className="rounded border border-emerald-700 bg-emerald-900/40 px-2 py-0.5 text-[11px] text-emerald-300 disabled:opacity-50">Add</button>
                </div>
              </div>
              <div className="space-y-1">
                {p.candidates.length === 0 && <div className="text-[11px] text-slate-500">No candidates yet.</div>}
                {p.candidates.map((c) => (
                  <div key={c.id} className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-[11px] ${c.isSelected ? 'border-emerald-700 bg-emerald-950/20' : 'border-slate-800'}`}>
                    <button onClick={() => patchCandidate(c.id, { isSelected: !c.isSelected })} title="Select supplier" className={c.isSelected ? 'text-emerald-400' : 'text-slate-600 hover:text-slate-300'}>{c.isSelected ? '★' : '☆'}</button>
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-200">
                      {c.supplier.name} <span className="text-slate-500">· LT {c.supplier.leadTimeDays}d</span>
                      {/* PD.6 — sourcing comparison badges */}
                      {c.quotedCostCents != null && p.candidates.filter((x) => x.quotedCostCents != null).every((x) => c.quotedCostCents! <= x.quotedCostCents!) && <span className="ml-1 rounded bg-emerald-900/60 px-1 text-[9px] text-emerald-300">cheapest</span>}
                      {p.candidates.every((x) => c.supplier.leadTimeDays <= x.supplier.leadTimeDays) && <span className="ml-1 rounded bg-blue-900/60 px-1 text-[9px] text-blue-300">fastest</span>}
                      {p.targetCostCents != null && c.quotedCostCents != null && c.quotedCostCents > p.targetCostCents && <span className="ml-1 rounded bg-rose-950/60 px-1 text-[9px] text-rose-300">over target</span>}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <span className="text-slate-500">quote €</span>
                      <input type="number" step="0.01" defaultValue={c.quotedCostCents != null ? (c.quotedCostCents / 100).toFixed(2) : ''} onBlur={(e) => patchCandidate(c.id, { quotedCostEur: e.target.value })} className="w-16 rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-right text-slate-100" />
                    </span>
                    <select defaultValue={c.sampleStatus ?? ''} onChange={(e) => patchCandidate(c.id, { sampleStatus: e.target.value })} className="rounded border border-slate-700 bg-slate-950 px-1 py-0.5 text-[10px] text-slate-100">
                      <option value="">sample…</option>
                      {['REQUESTED', 'RECEIVED', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <button onClick={() => delCandidate(c.id)} className="text-slate-600 hover:text-rose-400">✕</button>
                  </div>
                ))}
              </div>
            </div>

            {/* PD.7 — tech packs / reference art / sample photos */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-wide text-slate-500">Tech packs &amp; references</span>
                <label className="cursor-pointer rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700">
                  + Upload
                  <input type="file" className="hidden" onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return
                    const fd = new FormData(); fd.append('file', f); fd.append('kind', 'TECH_PACK')
                    await fetch(`${API}/api/fulfillment/development/projects/${id}/attachments`, { method: 'POST', body: fd })
                    e.target.value = ''
                    void load()
                  }} />
                </label>
              </div>
              <div className="space-y-1">
                {p.attachments.length === 0 && <div className="text-[11px] text-slate-500">No files yet.</div>}
                {p.attachments.map((a) => (
                  <div key={a.id} className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1 text-[11px]">
                    <span className="rounded bg-slate-800 px-1 text-[9px] text-slate-400">{a.kind}</span>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-blue-400 hover:underline">{a.filename ?? 'file'}</a>
                    <button onClick={async () => { await fetch(`${API}/api/fulfillment/development/projects/${id}/attachments/${a.id}`, { method: 'DELETE' }); void load() }} className="text-slate-600 hover:text-rose-400">✕</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
