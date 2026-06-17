'use client'

// FP.1 — new-product development board, rebuilt on the app's own design
// system (Card / Badge / Button / PageHeader, light + dark) so it matches
// the rest of the app. Project detail is now a full page (./[id]) instead
// of a cramped dark drawer.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, FlaskConical, ArrowRight } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

const API = getBackendUrl()

export const STATUSES = ['CONCEPT', 'SOURCING', 'SAMPLING', 'QUOTING', 'PRE_PRODUCTION', 'APPROVED', 'LAUNCHED', 'DROPPED', 'ON_HOLD'] as const

export const STATUS_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  CONCEPT: 'default', SOURCING: 'info', SAMPLING: 'info', QUOTING: 'info',
  PRE_PRODUCTION: 'warning', APPROVED: 'success', LAUNCHED: 'success',
  DROPPED: 'danger', ON_HOLD: 'default',
}

export type Project = {
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

export function eur(cents: number | null): string {
  return cents == null ? '—' : `€${(cents / 100).toLocaleString()}`
}

export default function DevelopmentClient() {
  const router = useRouter()
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [productType, setProductType] = useState('')
  const [statusFilter, setStatusFilter] = useState<string | null>(null)

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
      if (res.ok) { const p = await res.json(); router.push(`/fulfillment/suppliers/development/${p.id}`) }
    } finally { setCreating(false) }
  }

  const shown = useMemo(
    () => (statusFilter ? projects.filter((p) => p.status === statusFilter) : projects),
    [projects, statusFilter],
  )

  const inputCls = 'h-9 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-base text-slate-900 dark:text-slate-100 placeholder:text-tertiary focus:outline-none focus:ring-1 focus:ring-blue-500'

  return (
    <div className="space-y-5">
      <PageHeader
        title="Product Development"
        description="Develop new products from concept to launch — source suppliers, request samples, build the factory pack, clear certification."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Suppliers', href: '/fulfillment/suppliers' },
          { label: 'Development' },
        ]}
      />

      {/* New project */}
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void create() }} placeholder="New project name (e.g. Adventure helmet 2027)" className={`${inputCls} w-72`} />
          <input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="Product type (Helmet…)" className={`${inputCls} w-48`} />
          <Button variant="primary" icon={<Plus size={15} />} onClick={create} loading={creating} disabled={!name.trim()}>New project</Button>
        </div>
      </Card>

      {/* Pipeline funnel */}
      {projects.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <button onClick={() => setStatusFilter(null)} className={`rounded-md border px-2.5 py-1 text-sm font-medium ${statusFilter === null ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900' : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
            All {projects.length}
          </button>
          {STATUSES.filter((s) => projects.some((p) => p.status === s)).map((s) => {
            const n = projects.filter((p) => p.status === s).length
            const active = statusFilter === s
            return (
              <button key={s} onClick={() => setStatusFilter(active ? null : s)} className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm ${active ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/40' : 'border-default dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
                <Badge variant={STATUS_VARIANT[s]} size="sm">{s.replace(/_/g, ' ')}</Badge>
                <span className="tabular-nums text-slate-500 dark:text-slate-400">{n}</span>
              </button>
            )
          })}
        </div>
      )}

      {/* Projects table */}
      {loading ? (
        <Card><div className="py-10 text-center text-slate-500 dark:text-slate-400">Loading…</div></Card>
      ) : projects.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No development projects yet" description="Start one above to source suppliers, track samples, and build a factory pack." />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-base">
              <thead>
                <tr className="border-b border-default dark:border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  <th className="px-4 py-2.5 font-semibold">Project</th>
                  <th className="px-3 py-2.5 font-semibold">Status</th>
                  <th className="px-3 py-2.5 font-semibold">Type</th>
                  <th className="px-3 py-2.5 font-semibold text-right">Target cost</th>
                  <th className="px-3 py-2.5 font-semibold text-center">Suppliers</th>
                  <th className="px-3 py-2.5 font-semibold">Launch</th>
                  <th className="px-3 py-2.5"></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.id} onClick={() => router.push(`/fulfillment/suppliers/development/${p.id}`)} className="cursor-pointer border-b border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900 dark:text-slate-100">{p.name}</div>
                      <div className="font-mono text-xs text-tertiary dark:text-slate-500">{p.code}</div>
                    </td>
                    <td className="px-3 py-2.5"><Badge variant={STATUS_VARIANT[p.status]} size="sm">{p.status.replace(/_/g, ' ')}</Badge></td>
                    <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{p.productType ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-slate-700 dark:text-slate-300">{eur(p.targetCostCents)}</td>
                    <td className="px-3 py-2.5 text-center tabular-nums text-slate-600 dark:text-slate-400">{p._count?.candidates ?? 0}</td>
                    <td className="px-3 py-2.5 text-slate-600 dark:text-slate-300">{p.targetLaunchDate ? new Date(p.targetLaunchDate).toLocaleDateString() : '—'}</td>
                    <td className="px-3 py-2.5 text-right"><ArrowRight size={15} className="inline text-tertiary" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  )
}
