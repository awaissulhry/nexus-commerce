'use client'

// RX.2 — Return Policies CRUD.
//
// The resolver cascade is: (channel, marketplace, productType) →
// (channel, marketplace, *) → (channel, *, *) → EU baseline. Most-
// specific match wins; this page lets operators add/tune/retire the
// rows that feed every return-window and refund-deadline check on the
// surface (drawer badges, command-center SLA panel, create-return
// modal). Seeded baseline rows can be toggled inactive but not deleted.

import { useCallback, useEffect, useState } from 'react'
import { DateField } from '@/design-system/components/DateField'
import { Listbox } from '@/design-system/components/Listbox'
import {
  FileText, Plus, X, Trash2, Pencil, FlaskConical, ShieldCheck, AlertTriangle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { CHANNEL_TONE } from '@/app/_shared/returns'

type Policy = {
  id: string
  channel: string
  marketplace: string | null
  productType: string | null
  windowDays: number
  refundDeadlineDays: number
  buyerPaysReturn: boolean
  restockingFeePct: string | number | null
  autoApprove: boolean
  highValueThresholdCents: number | null
  isActive: boolean
  notes: string | null
}

const CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY'] as const

// EU marketplaces Xavia sells into (Amazon EU programme); blank = all.
const MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'NL', 'BE', 'IE', 'PL', 'SE', 'AT'] as const

type FormState = {
  channel: string
  marketplace: string
  productType: string
  windowDays: string
  refundDeadlineDays: string
  buyerPaysReturn: boolean
  restockingFeePct: string
  autoApprove: boolean
  highValueThresholdEuros: string
  notes: string
}

const EMPTY_FORM: FormState = {
  channel: 'AMAZON',
  marketplace: '',
  productType: '',
  windowDays: '14',
  refundDeadlineDays: '14',
  buyerPaysReturn: false,
  restockingFeePct: '',
  autoApprove: false,
  highValueThresholdEuros: '',
  notes: '',
}

function pct(v: Policy['restockingFeePct']): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'string' ? Number(v) : v
  return Number.isFinite(n) ? `${n}%` : '—'
}
function eur(cents: number | null): string {
  if (cents == null) return '—'
  return `€${Math.round(cents / 100).toLocaleString()}`
}

export default function PoliciesClient() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [items, setItems] = useState<Policy[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Policy | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  const fetchPolicies = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems((data.items ?? []) as Policy[])
      }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void fetchPolicies() }, [fetchPolicies])

  const openCreate = () => { setEditing(null); setForm(EMPTY_FORM); setModalOpen(true) }
  const openEdit = (p: Policy) => {
    setEditing(p)
    setForm({
      channel: p.channel,
      marketplace: p.marketplace ?? '',
      productType: p.productType ?? '',
      windowDays: String(p.windowDays),
      refundDeadlineDays: String(p.refundDeadlineDays),
      buyerPaysReturn: p.buyerPaysReturn,
      restockingFeePct: p.restockingFeePct == null ? '' : String(p.restockingFeePct),
      autoApprove: p.autoApprove,
      highValueThresholdEuros: p.highValueThresholdCents == null ? '' : String(Math.round(p.highValueThresholdCents / 100)),
      notes: p.notes ?? '',
    })
    setModalOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      const feePct = form.restockingFeePct.trim() === '' ? null : Number(form.restockingFeePct)
      const highCents = form.highValueThresholdEuros.trim() === '' ? null : Math.round(Number(form.highValueThresholdEuros) * 100)
      const common = {
        windowDays: Number(form.windowDays) || 14,
        refundDeadlineDays: Number(form.refundDeadlineDays) || 14,
        buyerPaysReturn: form.buyerPaysReturn,
        restockingFeePct: feePct,
        autoApprove: form.autoApprove,
        highValueThresholdCents: highCents,
        notes: form.notes.trim() || null,
      }
      let res: Response
      if (editing) {
        // PATCH can't move the (channel, marketplace, productType) key.
        res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(common),
        })
      } else {
        res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: form.channel,
            marketplace: form.marketplace.trim() || null,
            productType: form.productType.trim() || null,
            ...common,
          }),
        })
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? 'Save failed'); return }
      toast.success(editing ? 'Policy updated' : 'Policy created')
      setModalOpen(false)
      void fetchPolicies()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally { setSaving(false) }
  }

  const toggleActive = async (p: Policy) => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: !p.isActive }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error ?? 'Update failed'); return }
      void fetchPolicies()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Update failed') }
  }

  const remove = async (p: Policy) => {
    const ok = await askConfirm({
      title: `Delete policy for ${p.channel}${p.marketplace ? ` · ${p.marketplace}` : ''}${p.productType ? ` · ${p.productType}` : ''}?`,
      description: 'Returns under this scope will fall back to the next-broadest policy (or the EU baseline).',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies/${p.id}`, { method: 'DELETE' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(data.error ?? 'Delete failed'); return }
      toast.success('Policy deleted')
      void fetchPolicies()
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed') }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Return Policies"
        description="Per channel / marketplace / product-type return windows, refund SLAs, fees, and auto-approve rules. Most-specific match wins; unmatched returns fall back to the EU 14-day baseline."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Returns', href: '/fulfillment/returns' },
          { label: 'Policies' },
        ]}
        actions={
          <button
            onClick={openCreate}
            className="h-9 px-3 text-sm font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded inline-flex items-center gap-1.5 hover:bg-slate-700"
          >
            <Plus size={14} /> New policy
          </button>
        }
      />

      <Card noPadding>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-default dark:border-slate-700 text-left text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="px-3 py-2 font-semibold">Scope</th>
                <th className="px-3 py-2 font-semibold text-right">Window</th>
                <th className="px-3 py-2 font-semibold text-right">Refund SLA</th>
                <th className="px-3 py-2 font-semibold text-center">Buyer pays</th>
                <th className="px-3 py-2 font-semibold text-right">Restock fee</th>
                <th className="px-3 py-2 font-semibold text-center">Auto-approve</th>
                <th className="px-3 py-2 font-semibold text-right">High-value</th>
                <th className="px-3 py-2 font-semibold text-center">Active</th>
                <th className="px-3 py-2 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">Loading policies…</td></tr>
              ) : items.length === 0 ? (
                <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-500 dark:text-slate-400">
                  No policies yet. The EU 14-day baseline applies until you add one.
                </td></tr>
              ) : items.map((p) => (
                <tr key={p.id} className={`border-b border-subtle dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 ${!p.isActive ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[p.channel] ?? ''}`}>{p.channel}</span>
                      <span className="text-slate-600 dark:text-slate-300">{p.marketplace ?? 'All markets'}</span>
                      <span className="text-tertiary dark:text-slate-500">·</span>
                      <span className="text-slate-600 dark:text-slate-300">{p.productType ?? 'All products'}</span>
                      {p.id.startsWith('seed_') && <Badge variant="info" size="sm">baseline</Badge>}
                    </div>
                    {p.notes && <div className="text-xs text-tertiary dark:text-slate-500 mt-0.5 truncate max-w-md">{p.notes}</div>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.windowDays}d</td>
                  <td className="px-3 py-2 text-right tabular-nums">{p.refundDeadlineDays}d</td>
                  <td className="px-3 py-2 text-center">{p.buyerPaysReturn ? 'Buyer' : 'Seller'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(p.restockingFeePct)}</td>
                  <td className="px-3 py-2 text-center">
                    {p.autoApprove ? <Badge variant="warning" size="sm">Auto</Badge> : <span className="text-tertiary">Manual</span>}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{eur(p.highValueThresholdCents)}</td>
                  <td className="px-3 py-2 text-center">
                    <button
                      onClick={() => toggleActive(p)}
                      className={`text-xs px-2 py-0.5 rounded border ${p.isActive ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-900' : 'bg-slate-100 dark:bg-slate-800 text-slate-500 border-default dark:border-slate-700'}`}
                      title="Toggle active"
                    >
                      {p.isActive ? 'Active' : 'Off'}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEdit(p)} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-200 dark:hover:bg-slate-700" title="Edit"><Pencil size={13} /></button>
                      {!p.id.startsWith('seed_') && (
                        <button onClick={() => remove(p)} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-rose-100 dark:hover:bg-rose-900/40 text-rose-600 dark:text-rose-400" title="Delete"><Trash2 size={13} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <ResolverTester />

      {modalOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4" onClick={() => setModalOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-lg bg-white dark:bg-slate-900 rounded-lg shadow-2xl border border-default dark:border-slate-700 max-h-[90vh] overflow-y-auto">
            <header className="px-5 py-3 border-b border-default dark:border-slate-700 flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900">
              <h2 className="font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                <FileText size={15} /> {editing ? 'Edit policy' : 'New policy'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-700"><X size={16} /></button>
            </header>
            <div className="p-5 space-y-4">
              {/* Scope (immutable on edit — it's the unique key). */}
              <div className="grid grid-cols-3 gap-3">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Channel</span>
                  <Listbox
                    value={form.channel}
                    onChange={(v) => setForm((f) => ({ ...f, channel: v }))}
                    disabled={!!editing}
                    ariaLabel="Channel"
                    className="mt-1 w-full"
                    options={CHANNELS.map((c) => ({ value: c, label: c }))}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Marketplace</span>
                  <Listbox
                    value={form.marketplace}
                    onChange={(v) => setForm((f) => ({ ...f, marketplace: v }))}
                    disabled={!!editing}
                    ariaLabel="Marketplace"
                    className="mt-1 w-full"
                    options={[{ value: '', label: 'All' }, ...MARKETPLACES.map((m) => ({ value: m, label: m }))]}
                  />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Product type</span>
                  <input
                    value={form.productType}
                    onChange={(e) => setForm((f) => ({ ...f, productType: e.target.value }))}
                    disabled={!!editing}
                    placeholder="All"
                    className="mt-1 w-full h-9 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900 disabled:opacity-60"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Return window (days)</span>
                  <input type="number" min={0} value={form.windowDays} onChange={(e) => setForm((f) => ({ ...f, windowDays: e.target.value }))} className="mt-1 w-full h-9 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Refund deadline (days)</span>
                  <input type="number" min={0} value={form.refundDeadlineDays} onChange={(e) => setForm((f) => ({ ...f, refundDeadlineDays: e.target.value }))} className="mt-1 w-full h-9 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Restocking fee (%)</span>
                  <input type="number" min={0} max={100} step="0.5" value={form.restockingFeePct} onChange={(e) => setForm((f) => ({ ...f, restockingFeePct: e.target.value }))} placeholder="none" className="mt-1 w-full h-9 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
                </label>
                <label className="block">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">High-value threshold (€)</span>
                  <input type="number" min={0} value={form.highValueThresholdEuros} onChange={(e) => setForm((f) => ({ ...f, highValueThresholdEuros: e.target.value }))} placeholder="none" className="mt-1 w-full h-9 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
                </label>
              </div>

              <div className="flex items-center gap-5">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.buyerPaysReturn} onChange={(e) => setForm((f) => ({ ...f, buyerPaysReturn: e.target.checked }))} />
                  Buyer pays return shipping
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={form.autoApprove} onChange={(e) => setForm((f) => ({ ...f, autoApprove: e.target.checked }))} />
                  Auto-approve within window
                </label>
              </div>
              {form.autoApprove && (
                <p className="text-xs text-amber-700 dark:text-amber-300 inline-flex items-start gap-1.5">
                  <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  Auto-approve authorizes eligible returns without operator review. Refunds still require a human click.
                </p>
              )}

              <label className="block">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">Notes</span>
                <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} rows={2} className="mt-1 w-full px-2 py-1.5 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
              </label>
            </div>
            <footer className="px-5 py-3 border-t border-default dark:border-slate-700 flex justify-end gap-2 sticky bottom-0 bg-white dark:bg-slate-900">
              <button onClick={() => setModalOpen(false)} className="h-9 px-3 text-sm border border-default dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800">Cancel</button>
              <button onClick={save} disabled={saving} className="h-9 px-4 text-sm font-medium bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:bg-slate-700 disabled:opacity-50">
                {saving ? 'Saving…' : editing ? 'Save changes' : 'Create policy'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

// Compact resolver tester — confirms which policy a given return scope
// resolves to, plus the window check, before an operator relies on it.
function ResolverTester() {
  const [channel, setChannel] = useState<string>('AMAZON')
  const [marketplace, setMarketplace] = useState<string>('IT')
  const [productType, setProductType] = useState<string>('')
  const [deliveredAt, setDeliveredAt] = useState<string>('')
  const [result, setResult] = useState<any | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    try {
      const qs = new URLSearchParams({ channel })
      if (marketplace) qs.set('marketplace', marketplace)
      if (productType) qs.set('productType', productType)
      if (deliveredAt) qs.set('deliveredAt', new Date(deliveredAt).toISOString())
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/return-policies/resolve?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) setResult(await res.json())
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-200 inline-flex items-center gap-2 mb-3">
        <FlaskConical size={14} /> Test resolution
      </h3>
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Channel</span>
          <Listbox value={channel} onChange={setChannel} ariaLabel="Channel" className="mt-1 block w-32"
            options={CHANNELS.map((c) => ({ value: c, label: c }))} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Marketplace</span>
          <Listbox value={marketplace} onChange={setMarketplace} ariaLabel="Marketplace" className="mt-1 block w-28"
            options={[{ value: '', label: 'All' }, ...MARKETPLACES.map((m) => ({ value: m, label: m }))]} />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Product type</span>
          <input value={productType} onChange={(e) => setProductType(e.target.value)} placeholder="any" className="mt-1 block h-9 w-28 px-2 text-sm border border-default dark:border-slate-700 rounded bg-white dark:bg-slate-900" />
        </label>
        <label className="block">
          <span className="text-xs text-slate-500 dark:text-slate-400">Delivered at</span>
          <DateField value={deliveredAt} onChange={setDeliveredAt} ariaLabel="Delivered at" className="mt-1 block w-36" />
        </label>
        <button onClick={run} disabled={busy} className="h-9 px-3 text-sm font-medium border border-slate-300 dark:border-slate-600 rounded hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50">
          {busy ? 'Resolving…' : 'Resolve'}
        </button>
      </div>

      {result && (
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <Stat label="Window" value={`${result.policy?.windowDays ?? '—'}d`} />
          <Stat label="Refund SLA" value={`${result.policy?.refundDeadlineDays ?? '—'}d`} />
          <Stat label="Buyer pays" value={result.policy?.buyerPaysReturn ? 'Yes' : 'No'} />
          <Stat label="Source" value={result.policy?.source ?? '—'} />
          {result.window && (
            <div className="col-span-2 sm:col-span-4">
              {result.window.inWindow ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 text-sm">
                  <ShieldCheck size={14} /> In window — {result.window.daysSinceDelivery ?? 0}d since delivery (limit {result.policy?.windowDays}d)
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 text-rose-700 dark:text-rose-300 text-sm">
                  <AlertTriangle size={14} /> Outside window — {result.window.reason ?? 'past the return deadline'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-default dark:border-slate-700 px-3 py-2">
      <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">{label}</div>
      <div className="text-slate-900 dark:text-slate-100 font-semibold mt-0.5">{value}</div>
    </div>
  )
}
