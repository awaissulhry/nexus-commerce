'use client'

// FP.1 — development project detail, on the app design system. Tabs:
// Overview · Sourcing · Files · Compliance. (Factory Pack tab arrives in
// FP.7.) Migrates all the prior drawer logic into a proper light-themed
// page with the shared Card/Badge/Button components.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Rocket, Plus, Trash2, Star, Upload, FileText, ExternalLink, Send,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { STATUSES, eur, type Project } from '../DevelopmentClient'

const API = getBackendUrl()

type Candidate = {
  id: string; supplierId: string; quotedCostCents: number | null
  sampleStatus: string | null; isSelected: boolean; notes: string | null
  supplier: { id: string; name: string; leadTimeDays: number; defaultCurrency: string | null }
}
type DevAttachment = { id: string; kind: string; url: string; filename: string | null; uploadedAt: string; sortOrder?: number; caption?: string | null; includeInPack?: boolean }
const ATT_KINDS = ['TECH_PACK', 'REFERENCE', 'MEASUREMENT', 'SAMPLE_PHOTO', 'OTHER'] as const
function isImageFile(a: { filename: string | null; url: string }): boolean {
  return /\.(jpe?g|png|webp|gif|bmp|tiff?)($|\?)/i.test(a.filename ?? a.url)
}
function isPdfFile(a: { filename: string | null; url: string }): boolean {
  return /\.pdf($|\?)/i.test(a.filename ?? a.url)
}
type DevPo = { id: string; poNumber: string; status: string; poKind: string; totalCents: number }
type DevCert = { id: string; type: string; status: string; required: boolean; certNumber: string | null; expiresAt: string | null }
type SizeChart = { columns: string[]; rows: Array<{ size: string; values: string[] }>; tolerance?: string }
type BomRow = { component: string; material: string; spec: string }
type Colorway = { name: string; pantone?: string; hex?: string }
type ProjectDetail = Project & {
  candidates: Candidate[]; attachments: DevAttachment[]; purchaseOrders: DevPo[]; certifications: DevCert[]
  sizeChart: SizeChart | null; materials: BomRow[] | null; colorways: Colorway[] | null; specNotes: string | null; revision: number
}

const CERT_TYPES = ['CE', 'ECE_22_06', 'EN_13594', 'EN_1621', 'GPSR', 'OTHER'] as const
const CERT_VARIANT: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  PENDING: 'default', IN_PROGRESS: 'warning', APPROVED: 'success', REJECTED: 'danger',
}

const TABS = ['Overview', 'Spec', 'Sourcing', 'Files', 'Compliance', 'Pack'] as const
type Tab = (typeof TABS)[number]

const inputCls = 'h-9 w-full rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
const labelCls = 'text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400'

export default function ProjectDetailClient() {
  const params = useParams<{ id: string }>()
  const id = params?.id as string
  const router = useRouter()
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const [p, setP] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<Tab>('Overview')
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/fulfillment/development/projects/${id}`, { cache: 'no-store' })
      if (res.ok) setP(await res.json())
    } finally { setLoading(false) }
  }, [id])
  useEffect(() => { if (id) void load() }, [id, load])
  useEffect(() => {
    void (async () => {
      const res = await fetch(`${API}/api/fulfillment/suppliers`, { cache: 'no-store' })
      if (res.ok) setSuppliers((await res.json()).items ?? [])
    })()
  }, [])

  const patchProject = useCallback(async (b: Record<string, unknown>) => {
    const res = await fetch(`${API}/api/fulfillment/development/projects/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error ?? 'Update failed') }
    void load()
  }, [id, load, toast])

  const patchCandidate = async (cid: string, b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/development/projects/${id}/candidates/${cid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); void load() }
  const launch = async () => {
    const ok = await askConfirm({ title: 'Launch this project?', description: 'Creates a real Product and, if a supplier is selected, seeds its catalog with the factory name. Required certifications must be approved.', confirmLabel: 'Launch' })
    if (!ok) return
    const res = await fetch(`${API}/api/fulfillment/development/projects/${id}/launch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    const d = await res.json().catch(() => ({}))
    if (!res.ok) { toast.error(d.error ?? 'Launch failed'); return }
    toast.success('Launched — product created')
    void load()
    if (d.linkedProductId) window.open(`/products/${d.linkedProductId}/edit`, '_blank')
  }

  if (loading && !p) {
    return <div className="space-y-5"><PageHeader title="Project" breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Development', href: '/fulfillment/suppliers/development' }, { label: '…' }]} /><Card><div className="py-10 text-center text-slate-500">Loading…</div></Card></div>
  }
  if (!p) {
    return <div className="space-y-5"><PageHeader title="Project not found" breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Development', href: '/fulfillment/suppliers/development' }]} /></div>
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={p.name}
        description={`${p.code}${p.productType ? ` · ${p.productType}` : ''}`}
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Suppliers', href: '/fulfillment/suppliers' },
          { label: 'Development', href: '/fulfillment/suppliers/development' },
          { label: p.code },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={14} />} onClick={() => router.push('/fulfillment/suppliers/development')}>Back</Button>
            {p.linkedProductId ? (
              <a href={`/products/${p.linkedProductId}/edit`} target="_blank" rel="noopener noreferrer"><Badge variant="success">Launched → product ↗</Badge></a>
            ) : (
              <Button variant="primary" size="sm" icon={<Rocket size={14} />} onClick={launch}>Launch → product</Button>
            )}
          </div>
        }
      />

      {/* Tab bar */}
      <div className="flex items-center gap-1 border-b border-default dark:border-slate-800">
        {TABS.map((t) => {
          const count = t === 'Sourcing' ? p.candidates.length : t === 'Files' ? p.attachments.length : t === 'Compliance' ? p.certifications.length : undefined
          return (
            <button key={t} onClick={() => setTab(t)} className={`-mb-px border-b-2 px-3 py-2 text-base font-medium ${tab === t ? 'border-blue-600 text-blue-700 dark:text-blue-300' : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'}`}>
              {t}{count != null ? <span className="ml-1.5 text-xs text-tertiary">{count}</span> : null}
            </button>
          )
        })}
      </div>

      {tab === 'Overview' && <OverviewTab p={p} onPatch={patchProject} onReload={load} />}
      {tab === 'Spec' && <SpecTab p={p} onPatch={patchProject} />}
      {tab === 'Sourcing' && <SourcingTab p={p} suppliers={suppliers} onReload={load} onPatchCandidate={patchCandidate} />}
      {tab === 'Files' && <FilesTab p={p} onReload={load} />}
      {tab === 'Compliance' && <ComplianceTab p={p} onReload={load} />}
      {tab === 'Pack' && <PackTab p={p} />}
    </div>
  )
}

function PackTab({ p }: { p: ProjectDetail }) {
  const { toast } = useToast()
  const [locale, setLocale] = useState<'en' | 'it' | 'zh'>('en')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const pdfUrl = `${API}/api/fulfillment/development/projects/${p.id}/factory-pack.pdf?locale=${locale}`
  const includedCount = p.attachments.filter((a) => a.includeInPack !== false).length
  const send = async () => {
    if (!to.trim()) return
    setSending(true)
    try {
      const res = await fetch(`${API}/api/fulfillment/development/projects/${p.id}/send-pack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: to.trim(), locale, subject: subject.trim() || undefined, message: message.trim() || undefined }) })
      const d = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(d.error ?? 'Send failed'); return }
      toast.success(d.delivery?.dryRun ? 'Pack queued (dry-run)' : 'Pack emailed to factory')
    } finally { setSending(false) }
  }
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <Card title="Factory pack" description="Cover + brief + size chart + materials + colorways + images + tech-pack appendix, in one PDF.">
        <div className="space-y-3">
          <label className="block"><span className={labelCls}>Language</span>
            <select value={locale} onChange={(e) => setLocale(e.target.value as 'en' | 'it' | 'zh')} className={`${inputCls} mt-1`}>
              <option value="en">English</option><option value="it">Italiano</option><option value="zh">中文 (Chinese)</option>
            </select>
          </label>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            Rev {p.revision} · {includedCount} file{includedCount === 1 ? '' : 's'} included{p.sizeChart?.rows?.length ? ` · size chart (${p.sizeChart.rows.length} sizes)` : ''}{p.materials?.length ? ` · ${p.materials.length} materials` : ''}.
          </p>
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer"><Button variant="primary" icon={<FileText size={14} />}>Preview / Download</Button></a>
        </div>
      </Card>
      <Card title="Send to factory" description="Email the pack (PDF attached); logged to the supplier's comms timeline.">
        <div className="space-y-2.5">
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="factory@example.com" className={inputCls} />
          <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject (optional)" className={inputCls} />
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Message (optional)…" className="w-full rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          <Button variant="primary" icon={<Send size={14} />} loading={sending} disabled={!to.trim()} onClick={send}>Send pack</Button>
        </div>
      </Card>
    </div>
  )
}

function OverviewTab({ p, onPatch, onReload }: { p: ProjectDetail; onPatch: (b: Record<string, unknown>) => void; onReload: () => void }) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
      <div className="lg:col-span-2 space-y-5">
        <Card title="Brief & specs">
          <textarea defaultValue={p.brief ?? ''} rows={6} onBlur={(e) => onPatch({ brief: e.target.value })} placeholder="What are we developing — target specs, construction notes, references…" className="w-full rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </Card>
        <Card title="Sample purchase orders" action={<SamplePoButton projectId={p.id} onReload={onReload} />}>
          {p.purchaseOrders.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">No sample POs yet. Select a candidate supplier in Sourcing, then create one.</p>
          ) : (
            <div className="space-y-1.5">
              {p.purchaseOrders.map((po) => (
                <a key={po.id} href={`/fulfillment/purchase-orders/${po.id}`} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border border-default dark:border-slate-800 px-2.5 py-1.5 text-base hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <Badge variant="info" size="sm">{po.poKind}</Badge>
                  <span className="font-mono text-slate-700 dark:text-slate-300">{po.poNumber}</span>
                  <span className="text-sm text-slate-500">{po.status}</span>
                  <span className="ml-auto tabular-nums text-slate-600 dark:text-slate-400">{eur(po.totalCents)}</span>
                  <ExternalLink size={13} className="text-tertiary" />
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Card title="Details">
        <div className="space-y-3">
          <label className="block">
            <span className={labelCls}>Status</span>
            <select defaultValue={p.status} onChange={(e) => onPatch({ status: e.target.value })} className={`${inputCls} mt-1`}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="block">
            <span className={labelCls}>Product type</span>
            <input defaultValue={p.productType ?? ''} onBlur={(e) => onPatch({ productType: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className="block">
            <span className={labelCls}>Target cost (€)</span>
            <input type="number" step="0.01" defaultValue={p.targetCostCents != null ? (p.targetCostCents / 100).toFixed(2) : ''} onBlur={(e) => onPatch({ targetCostEur: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
          <label className="block">
            <span className={labelCls}>Target launch</span>
            <input type="date" defaultValue={p.targetLaunchDate ? p.targetLaunchDate.slice(0, 10) : ''} onBlur={(e) => onPatch({ targetLaunchDate: e.target.value })} className={`${inputCls} mt-1`} />
          </label>
        </div>
      </Card>
    </div>
  )
}

function SamplePoButton({ projectId, onReload }: { projectId: string; onReload: () => void }) {
  const { toast } = useToast()
  const [busy, setBusy] = useState(false)
  return (
    <Button variant="secondary" size="sm" icon={<Plus size={14} />} loading={busy} onClick={async () => {
      setBusy(true)
      try {
        const res = await fetch(`${API}/api/fulfillment/development/projects/${projectId}/sample-po`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(d.error ?? 'Failed'); return }
        onReload()
        if (d.id) window.open(`/fulfillment/purchase-orders/${d.id}`, '_blank')
      } finally { setBusy(false) }
    }}>Sample PO</Button>
  )
}

function SourcingTab({ p, suppliers, onReload, onPatchCandidate }: { p: ProjectDetail; suppliers: Array<{ id: string; name: string }>; onReload: () => void; onPatchCandidate: (cid: string, b: Record<string, unknown>) => void }) {
  const [addId, setAddId] = useState('')
  const { toast } = useToast()
  const quotes = useMemo(() => p.candidates.map((c) => c.quotedCostCents).filter((n): n is number => n != null), [p.candidates])
  const minLt = useMemo(() => p.candidates.length ? Math.min(...p.candidates.map((c) => c.supplier.leadTimeDays)) : null, [p.candidates])
  const addCandidate = async () => {
    if (!addId) return
    const res = await fetch(`${API}/api/fulfillment/development/projects/${p.id}/candidates`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierId: addId }) })
    if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error ?? 'Failed') }
    setAddId(''); onReload()
  }
  return (
    <Card title="Candidate suppliers" action={
      <div className="flex items-center gap-2">
        <select value={addId} onChange={(e) => setAddId(e.target.value)} className={`${inputCls} w-48`}>
          <option value="">+ add supplier…</option>
          {suppliers.filter((s) => !p.candidates.some((c) => c.supplierId === s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Button variant="secondary" size="sm" onClick={addCandidate} disabled={!addId}>Add</Button>
      </div>
    }>
      {p.candidates.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No candidates yet. Add suppliers to compare quotes and lead times.</p>
      ) : (
        <div className="space-y-2">
          {p.candidates.map((c) => {
            const cheapest = c.quotedCostCents != null && quotes.length > 0 && c.quotedCostCents === Math.min(...quotes)
            const fastest = minLt != null && c.supplier.leadTimeDays === minLt
            const over = p.targetCostCents != null && c.quotedCostCents != null && c.quotedCostCents > p.targetCostCents
            return (
              <div key={c.id} className={`flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 ${c.isSelected ? 'border-emerald-300 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20' : 'border-default dark:border-slate-800'}`}>
                <button onClick={() => onPatchCandidate(c.id, { isSelected: !c.isSelected })} title="Select supplier" className={c.isSelected ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}><Star size={16} className={c.isSelected ? 'fill-amber-400' : ''} /></button>
                <span className="font-medium text-slate-900 dark:text-slate-100">{c.supplier.name}</span>
                <span className="text-sm text-slate-500">LT {c.supplier.leadTimeDays}d</span>
                {cheapest && <Badge variant="success" size="sm">cheapest</Badge>}
                {fastest && <Badge variant="info" size="sm">fastest</Badge>}
                {over && <Badge variant="danger" size="sm">over target</Badge>}
                <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-slate-500">quote €
                  <input type="number" step="0.01" defaultValue={c.quotedCostCents != null ? (c.quotedCostCents / 100).toFixed(2) : ''} onBlur={(e) => onPatchCandidate(c.id, { quotedCostEur: e.target.value })} className="h-8 w-20 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-right text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </span>
                <select defaultValue={c.sampleStatus ?? ''} onChange={(e) => onPatchCandidate(c.id, { sampleStatus: e.target.value })} className="h-8 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none">
                  <option value="">sample…</option>
                  {['REQUESTED', 'RECEIVED', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <button onClick={async () => { await fetch(`${API}/api/fulfillment/development/projects/${p.id}/candidates/${c.id}`, { method: 'DELETE' }); onReload() }} className="text-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function FilesTab({ p, onReload }: { p: ProjectDetail; onReload: () => void }) {
  const [uploading, setUploading] = useState(false)
  const patchAtt = async (aid: string, b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/development/projects/${p.id}/attachments/${aid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); onReload() }
  const move = async (i: number, dir: -1 | 1) => {
    const arr = [...p.attachments]
    const j = i + dir
    if (j < 0 || j >= arr.length) return
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
    // persist sequential order
    await Promise.all(arr.map((a, idx) => fetch(`${API}/api/fulfillment/development/projects/${p.id}/attachments/${a.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sortOrder: idx }) })))
    onReload()
  }
  return (
    <Card title="Tech packs, references & sample photos" description="What goes in the factory pack — toggle, caption, and order each file." action={
      <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2.5 py-1.5 text-base font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800">
        {uploading ? '…' : <><Upload size={14} /> Upload</>}
        <input type="file" className="hidden" disabled={uploading} onChange={async (e) => {
          const f = e.target.files?.[0]; if (!f) return
          setUploading(true)
          try {
            const kind = /\.(jpe?g|png|webp|gif)$/i.test(f.name) ? 'REFERENCE' : 'TECH_PACK'
            const fd = new FormData(); fd.append('file', f); fd.append('kind', kind)
            await fetch(`${API}/api/fulfillment/development/projects/${p.id}/attachments`, { method: 'POST', body: fd })
            e.target.value = ''; onReload()
          } finally { setUploading(false) }
        }} />
      </label>
    }>
      {p.attachments.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No files yet. Upload tech packs, reference art, measurement sheets, or sample photos.</p>
      ) : (
        <div className="space-y-2">
          {p.attachments.map((a, i) => {
            const img = isImageFile(a)
            return (
              <div key={a.id} className="flex items-start gap-3 rounded-md border border-default dark:border-slate-800 p-2">
                <div className="flex flex-col gap-0.5 pt-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-tertiary hover:text-slate-700 disabled:opacity-30">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === p.attachments.length - 1} className="text-tertiary hover:text-slate-700 disabled:opacity-30">▼</button>
                </div>
                {img ? (
                  <a href={a.url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={a.url} alt={a.caption ?? a.filename ?? ''} className="h-14 w-14 rounded object-cover ring-1 ring-slate-200 dark:ring-slate-700" />
                  </a>
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded bg-slate-100 dark:bg-slate-800">
                    {isPdfFile(a) ? <FileText size={20} className="text-rose-500" /> : <FileText size={20} className="text-tertiary" />}
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <select defaultValue={a.kind} onChange={(e) => patchAtt(a.id, { kind: e.target.value })} className="h-7 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none">
                      {ATT_KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, ' ')}</option>)}
                    </select>
                    <a href={a.url} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-base text-blue-700 hover:underline dark:text-blue-300">{a.filename ?? 'file'}</a>
                    <label className="inline-flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-400">
                      <input type="checkbox" defaultChecked={a.includeInPack !== false} onChange={(e) => patchAtt(a.id, { includeInPack: e.target.checked })} /> in pack
                    </label>
                    <button onClick={async () => { await fetch(`${API}/api/fulfillment/development/projects/${p.id}/attachments/${a.id}`, { method: 'DELETE' }); onReload() }} className="text-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
                  </div>
                  <input defaultValue={a.caption ?? ''} onBlur={(e) => patchAtt(a.id, { caption: e.target.value })} placeholder="Caption (e.g. logo placement, stitching detail)…" className="h-8 w-full rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-2 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

const SIZE_PRESETS: Record<string, string[]> = {
  'Helmet (XS–XXL)': ['XS', 'S', 'M', 'L', 'XL', 'XXL'],
  'Jacket EU (44–60)': ['44', '46', '48', '50', '52', '54', '56', '58', '60'],
  'Apparel (S–XXL)': ['S', 'M', 'L', 'XL', 'XXL'],
}

function SpecTab({ p, onPatch }: { p: ProjectDetail; onPatch: (b: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-5">
      <Card title="Size chart" description="Measurements the factory cuts to. Rows = sizes, columns = measurements (cm).">
        <SizeChartEditor value={p.sizeChart} onSave={(sizeChart) => onPatch({ sizeChart })} />
      </Card>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Card title="Materials / BOM" description="What the factory sources.">
          <MaterialsEditor value={p.materials} onSave={(materials) => onPatch({ materials })} />
        </Card>
        <Card title="Colorways" description="Colour specs with Pantone / hex.">
          <ColorwaysEditor value={p.colorways} onSave={(colorways) => onPatch({ colorways })} />
        </Card>
      </div>
      <Card title="Construction & special instructions">
        <textarea defaultValue={p.specNotes ?? ''} rows={5} onBlur={(e) => onPatch({ specNotes: e.target.value })} placeholder="Stitching, seams, reinforcement, tolerances, packaging…" className="w-full rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
      </Card>
    </div>
  )
}

function MaterialsEditor({ value, onSave }: { value: BomRow[] | null; onSave: (rows: BomRow[]) => void }) {
  const [rows, setRows] = useState<BomRow[]>(value ?? [])
  const [structVer, setStructVer] = useState(0)
  const save = (next: BomRow[], structural = false) => { setRows(next); onSave(next); if (structural) setStructVer((v) => v + 1) }
  const fieldCls = 'h-8 w-full rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
  return (
    <div className="space-y-2" key={structVer}>
      {rows.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">No materials yet.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-1.5">
          <input defaultValue={r.component} placeholder="Component (shell…)" onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, component: e.target.value } : x))} className={fieldCls} />
          <input defaultValue={r.material} placeholder="Material (polycarb…)" onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, material: e.target.value } : x))} className={fieldCls} />
          <input defaultValue={r.spec} placeholder="Spec / grade" onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, spec: e.target.value } : x))} className={fieldCls} />
          <button onClick={() => save(rows.filter((_, j) => j !== i), true)} className="text-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
        </div>
      ))}
      <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => save([...rows, { component: '', material: '', spec: '' }], true)}>Add material</Button>
    </div>
  )
}

function ColorwaysEditor({ value, onSave }: { value: Colorway[] | null; onSave: (rows: Colorway[]) => void }) {
  const [rows, setRows] = useState<Colorway[]>(value ?? [])
  const [structVer, setStructVer] = useState(0)
  const save = (next: Colorway[], structural = false) => { setRows(next); onSave(next); if (structural) setStructVer((v) => v + 1) }
  const fieldCls = 'h-8 w-full rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
  return (
    <div className="space-y-2" key={structVer}>
      {rows.length === 0 && <p className="text-sm text-slate-500 dark:text-slate-400">No colorways yet.</p>}
      {rows.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto] items-center gap-1.5">
          <input defaultValue={r.name} placeholder="Name (Matte Black…)" onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} className={fieldCls} />
          <input defaultValue={r.pantone ?? ''} placeholder="Pantone (e.g. 426 C)" onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, pantone: e.target.value } : x))} className={fieldCls} />
          <input type="color" defaultValue={r.hex ?? '#000000'} onBlur={(e) => save(rows.map((x, j) => j === i ? { ...x, hex: e.target.value } : x))} className="h-8 w-9 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900" />
          <button onClick={() => save(rows.filter((_, j) => j !== i), true)} className="text-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
        </div>
      ))}
      <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => save([...rows, { name: '', pantone: '', hex: '#000000' }], true)}>Add colorway</Button>
    </div>
  )
}

function SizeChartEditor({ value, onSave }: { value: SizeChart | null; onSave: (c: SizeChart) => void }) {
  const [chart, setChart] = useState<SizeChart>(value ?? { columns: ['Chest', 'Length'], rows: [], tolerance: '' })
  const [structVer, setStructVer] = useState(0)
  const save = (next: SizeChart, structural = false) => { setChart(next); onSave(next); if (structural) setStructVer((v) => v + 1) }

  const addColumn = () => { const name = window.prompt('Measurement name (e.g. Chest, Sleeve)'); if (!name?.trim()) return; save({ ...chart, columns: [...chart.columns, name.trim()], rows: chart.rows.map((r) => ({ ...r, values: [...r.values, ''] })) }, true) }
  const removeColumn = (ci: number) => save({ ...chart, columns: chart.columns.filter((_, i) => i !== ci), rows: chart.rows.map((r) => ({ ...r, values: r.values.filter((_, i) => i !== ci) })) }, true)
  const addRow = () => { const size = window.prompt('Size label (e.g. M, 52)'); if (!size?.trim()) return; save({ ...chart, rows: [...chart.rows, { size: size.trim(), values: chart.columns.map(() => '') }] }, true) }
  const removeRow = (ri: number) => save({ ...chart, rows: chart.rows.filter((_, i) => i !== ri) }, true)
  const setCell = (ri: number, ci: number, v: string) => { const rows = chart.rows.map((r, i) => i === ri ? { ...r, values: r.values.map((x, j) => j === ci ? v : x) } : r); save({ ...chart, rows }) }
  const applyPreset = (sizes: string[]) => save({ ...chart, rows: sizes.map((s) => ({ size: s, values: chart.columns.map(() => '') })) }, true)

  const cellCls = 'h-8 w-20 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-right text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500'
  return (
    <div className="space-y-3" key={structVer}>
      {chart.rows.length === 0 && chart.columns.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-sm text-slate-500">
          <span>Quick start:</span>
          {Object.entries(SIZE_PRESETS).map(([k, sizes]) => <Button key={k} variant="ghost" size="sm" onClick={() => applyPreset(sizes)}>{k}</Button>)}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="text-base">
          <thead>
            <tr>
              <th className="px-2 py-1 text-left text-xs uppercase tracking-wider text-slate-500">Size</th>
              {chart.columns.map((c, ci) => (
                <th key={ci} className="px-2 py-1 text-left">
                  <span className="inline-flex items-center gap-1">
                    <input defaultValue={c} onBlur={(e) => { const cols = chart.columns.map((x, i) => i === ci ? e.target.value : x); save({ ...chart, columns: cols }) }} className="h-7 w-20 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1 text-sm font-medium text-slate-700 dark:text-slate-200 focus:outline-none" />
                    <button onClick={() => removeColumn(ci)} className="text-slate-300 hover:text-rose-500"><Trash2 size={12} /></button>
                  </span>
                </th>
              ))}
              <th className="px-2"><Button variant="ghost" size="sm" icon={<Plus size={13} />} onClick={addColumn}>Col</Button></th>
            </tr>
          </thead>
          <tbody>
            {chart.rows.map((r, ri) => (
              <tr key={ri} className="border-t border-subtle dark:border-slate-800">
                <td className="px-2 py-1"><input defaultValue={r.size} onBlur={(e) => { const rows = chart.rows.map((x, i) => i === ri ? { ...x, size: e.target.value } : x); save({ ...chart, rows }) }} className="h-8 w-16 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base font-medium text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" /></td>
                {chart.columns.map((_, ci) => (
                  <td key={ci} className="px-2 py-1"><input defaultValue={r.values[ci] ?? ''} onBlur={(e) => setCell(ri, ci, e.target.value)} className={cellCls} /></td>
                ))}
                <td><button onClick={() => removeRow(ri)} className="text-slate-300 hover:text-rose-500"><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={addRow}>Add size</Button>
        <label className="inline-flex items-center gap-1.5 text-sm text-slate-500">Tolerance
          <input defaultValue={chart.tolerance ?? ''} onBlur={(e) => save({ ...chart, tolerance: e.target.value })} placeholder="± 1cm" className="h-8 w-24 rounded border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
        </label>
      </div>
    </div>
  )
}

function ComplianceTab({ p, onReload }: { p: ProjectDetail; onReload: () => void }) {
  const patchCert = async (cid: string, b: Record<string, unknown>) => { await fetch(`${API}/api/fulfillment/development/projects/${p.id}/certifications/${cid}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); onReload() }
  return (
    <Card title="Compliance / certifications" description="Required certifications gate launch (CE / ECE 22.06 / EN 13594 / EN 1621 / GPSR)." action={
      <select defaultValue="" onChange={async (e) => { const t = e.target.value; if (!t) return; e.target.value = ''; await fetch(`${API}/api/fulfillment/development/projects/${p.id}/certifications`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: t }) }); onReload() }} className={`${inputCls} w-44`}>
        <option value="">+ add cert…</option>
        {CERT_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
      </select>
    }>
      {p.certifications.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">No certifications tracked yet.</p>
      ) : (
        <div className="space-y-2">
          {p.certifications.map((cert) => (
            <div key={cert.id} className="flex flex-wrap items-center gap-2 rounded-md border border-default dark:border-slate-800 px-3 py-2">
              <span className="font-medium text-slate-900 dark:text-slate-100">{cert.type.replace(/_/g, ' ')}</span>
              {cert.required && <Badge variant="default" size="sm">required</Badge>}
              <select defaultValue={cert.status} onChange={(e) => patchCert(cert.id, { status: e.target.value })} className="h-8 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-sm text-slate-700 dark:text-slate-200 focus:outline-none">
                {['PENDING', 'IN_PROGRESS', 'APPROVED', 'REJECTED'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
              <Badge variant={CERT_VARIANT[cert.status] ?? 'default'} size="sm">{cert.status.replace(/_/g, ' ')}</Badge>
              <input defaultValue={cert.certNumber ?? ''} onBlur={(e) => patchCert(cert.id, { certNumber: e.target.value })} placeholder="cert #" className="h-8 w-28 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <input type="date" defaultValue={cert.expiresAt ? cert.expiresAt.slice(0, 10) : ''} onBlur={(e) => patchCert(cert.id, { expiresAt: e.target.value })} className="h-8 rounded-md border border-default dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 text-base text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
              <button onClick={async () => { await fetch(`${API}/api/fulfillment/development/projects/${p.id}/certifications/${cert.id}`, { method: 'DELETE' }); onReload() }} className="ml-auto text-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}
