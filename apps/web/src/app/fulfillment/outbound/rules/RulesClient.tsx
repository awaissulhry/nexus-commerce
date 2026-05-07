'use client'

// O.16 — Shipping rules CRUD. List + edit modal. The applier
// (services/shipping-rules/applier.ts) consumes these from
// bulk-create-shipments. First-match-wins, walked priority ASC.

import { useCallback, useEffect, useState } from 'react'
import {
  Plus, Pencil, Trash2, ScrollText, Check, X, RefreshCw,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'

interface RuleConditions {
  channel?: string[]
  marketplace?: string[]
  destinationCountry?: string[]
  weightGramsMin?: number
  weightGramsMax?: number
  orderTotalCentsMin?: number
  orderTotalCentsMax?: number
  itemCountMin?: number
  itemCountMax?: number
  isPrime?: boolean
  hasHazmat?: boolean
}

interface RuleActions {
  preferCarrierCode?: string
  preferServiceCode?: string
  requireSignature?: boolean
  requireInsurance?: boolean
  insuranceCents?: number
  packagingId?: string
  holdForReview?: boolean
  addLabel?: string
}

interface ShippingRule {
  id: string
  name: string
  description: string | null
  priority: number
  isActive: boolean
  conditions: RuleConditions
  actions: RuleActions
  lastFiredAt: string | null
  triggerCount: number
  createdAt: string
  updatedAt: string
}

const CARRIER_OPTIONS = [
  'SENDCLOUD', 'AMAZON_BUY_SHIPPING', 'BRT', 'POSTE', 'GLS', 'SDA',
  'TNT', 'DHL', 'UPS', 'FEDEX', 'DPD', 'CHRONOPOST',
]
const CHANNEL_OPTIONS = ['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY', 'MANUAL']

export default function RulesClient() {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [rules, setRules] = useState<ShippingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<ShippingRule | null>(null)
  const [showNew, setShowNew] = useState(false)

  const fetchRules = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipping-rules`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setRules(data.items ?? [])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRules() }, [fetchRules])

  const onDelete = async (rule: ShippingRule) => {
    if (!(await askConfirm({
      title: 'Delete rule?',
      description: `"${rule.name}" will stop firing. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    }))) return
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipping-rules/${rule.id}`, {
      method: 'DELETE',
    })
    if (res.ok) {
      toast.success('Rule deleted')
      fetchRules()
    } else {
      toast.error('Failed to delete')
    }
  }

  const onToggleActive = async (rule: ShippingRule) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/shipping-rules/${rule.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isActive: !rule.isActive }),
    })
    if (res.ok) {
      toast.success(rule.isActive ? 'Rule disabled' : 'Rule enabled')
      fetchRules()
    } else {
      toast.error('Failed to update')
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Shipping rules"
        description="WHEN ⟨conditions⟩ THEN ⟨actions⟩. Walked in priority ASC; first match wins. Applies at shipment creation."
        breadcrumbs={[
          { label: 'Fulfillment', href: '/fulfillment' },
          { label: 'Outbound', href: '/fulfillment/outbound' },
          { label: 'Rules' },
        ]}
        actions={
          <div className="flex items-center gap-2">
            <button onClick={fetchRules} className="h-8 px-3 text-base border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
              <RefreshCw size={12} /> Refresh
            </button>
            <button onClick={() => setShowNew(true)} className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5">
              <Plus size={12} /> New rule
            </button>
          </div>
        }
      />

      {loading && rules.length === 0 ? (
        <Card><div className="text-md text-slate-500 py-8 text-center">Loading rules…</div></Card>
      ) : rules.length === 0 ? (
        <Card>
          <div className="py-8 text-center space-y-2">
            <ScrollText size={28} className="mx-auto text-slate-300" />
            <div className="text-md text-slate-700 font-medium">No shipping rules yet</div>
            <div className="text-base text-slate-500">
              Without rules, every shipment defaults to SENDCLOUD.<br />
              Define a rule to override carrier / service per order context.
            </div>
            <button onClick={() => setShowNew(true)} className="h-8 px-3 mt-2 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5">
              <Plus size={12} /> Create the first rule
            </button>
          </div>
        </Card>
      ) : (
        <Card noPadding>
          <table className="w-full text-md">
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700 w-16">Pri</th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Rule</th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">When</th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Then</th>
                <th className="px-3 py-2 text-left text-sm font-semibold uppercase tracking-wider text-slate-700">Activity</th>
                <th className="px-3 py-2 text-right text-sm font-semibold uppercase tracking-wider text-slate-700"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className={`border-b border-slate-100 hover:bg-slate-50 ${!r.isActive ? 'opacity-50' : ''}`}>
                  <td className="px-3 py-2 tabular-nums text-slate-700">{r.priority}</td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{r.name}</div>
                    {r.description && <div className="text-sm text-slate-500">{r.description}</div>}
                  </td>
                  <td className="px-3 py-2 text-sm text-slate-600">{summarizeConditions(r.conditions)}</td>
                  <td className="px-3 py-2 text-sm text-slate-600">{summarizeActions(r.actions)}</td>
                  <td className="px-3 py-2 text-sm text-slate-600">
                    <span className="tabular-nums">{r.triggerCount}</span> fires
                    {r.lastFiredAt && <div className="text-xs text-slate-400">last: {new Date(r.lastFiredAt).toLocaleDateString('it-IT')}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center gap-1 justify-end">
                      <button onClick={() => onToggleActive(r)} className="h-6 px-2 text-sm text-slate-600 border border-slate-200 rounded hover:bg-white inline-flex items-center gap-1" title={r.isActive ? 'Disable' : 'Enable'}>
                        {r.isActive ? <X size={11} /> : <Check size={11} />}
                        {r.isActive ? 'Disable' : 'Enable'}
                      </button>
                      <button onClick={() => setEditing(r)} className="h-6 w-6 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded" title="Edit">
                        <Pencil size={11} />
                      </button>
                      <button onClick={() => onDelete(r)} className="h-6 w-6 inline-flex items-center justify-center text-rose-500 hover:text-rose-700 hover:bg-rose-50 rounded" title="Delete">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {(showNew || editing) && (
        <RuleEditModal
          rule={editing}
          onClose={() => {
            setShowNew(false)
            setEditing(null)
          }}
          onSaved={() => {
            setShowNew(false)
            setEditing(null)
            fetchRules()
          }}
        />
      )}
    </div>
  )
}

function summarizeConditions(c: RuleConditions): string {
  const parts: string[] = []
  if (c.channel?.length) parts.push(`channel ∈ ${c.channel.join(',')}`)
  if (c.marketplace?.length) parts.push(`mkt ∈ ${c.marketplace.join(',')}`)
  if (c.destinationCountry?.length) parts.push(`country ∈ ${c.destinationCountry.join(',')}`)
  if (c.weightGramsMin != null || c.weightGramsMax != null) {
    parts.push(`weight ${c.weightGramsMin ?? 0}–${c.weightGramsMax ?? '∞'}g`)
  }
  if (c.orderTotalCentsMin != null || c.orderTotalCentsMax != null) {
    parts.push(`total €${(c.orderTotalCentsMin ?? 0) / 100}–${c.orderTotalCentsMax != null ? (c.orderTotalCentsMax / 100).toFixed(0) : '∞'}`)
  }
  if (c.isPrime === true) parts.push('Prime')
  if (c.isPrime === false) parts.push('non-Prime')
  return parts.length ? parts.join(' · ') : 'any order'
}

function summarizeActions(a: RuleActions): string {
  const parts: string[] = []
  if (a.preferCarrierCode) parts.push(`use ${a.preferCarrierCode}`)
  if (a.preferServiceCode) parts.push(`(${a.preferServiceCode})`)
  if (a.requireSignature) parts.push('signature')
  if (a.requireInsurance) parts.push(`insure ${a.insuranceCents != null ? '€' + (a.insuranceCents / 100).toFixed(0) : ''}`)
  if (a.holdForReview) parts.push('hold for review')
  return parts.length ? parts.join(' · ') : '(no actions)'
}

// ── Edit modal ─────────────────────────────────────────────────────────
function RuleEditModal({
  rule,
  onClose,
  onSaved,
}: {
  rule: ShippingRule | null
  onClose: () => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const isNew = !rule
  const [name, setName] = useState(rule?.name ?? '')
  const [description, setDescription] = useState(rule?.description ?? '')
  const [priority, setPriority] = useState(String(rule?.priority ?? 100))
  const [isActive, setIsActive] = useState(rule?.isActive ?? true)
  const [channel, setChannel] = useState((rule?.conditions.channel ?? []).join(','))
  const [destCountry, setDestCountry] = useState((rule?.conditions.destinationCountry ?? []).join(','))
  const [weightMin, setWeightMin] = useState(String(rule?.conditions.weightGramsMin ?? ''))
  const [weightMax, setWeightMax] = useState(String(rule?.conditions.weightGramsMax ?? ''))
  const [isPrime, setIsPrime] = useState<'any' | 'yes' | 'no'>(
    rule?.conditions.isPrime === true ? 'yes' : rule?.conditions.isPrime === false ? 'no' : 'any',
  )
  const [carrier, setCarrier] = useState(rule?.actions.preferCarrierCode ?? '')
  const [service, setService] = useState(rule?.actions.preferServiceCode ?? '')
  const [requireSig, setRequireSig] = useState(rule?.actions.requireSignature ?? false)
  const [requireIns, setRequireIns] = useState(rule?.actions.requireInsurance ?? false)
  const [holdReview, setHoldReview] = useState(rule?.actions.holdForReview ?? false)
  const [saving, setSaving] = useState(false)

  const splitCsv = (s: string) =>
    s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)

  const submit = async () => {
    if (!name.trim()) { toast.error('Name is required'); return }
    setSaving(true)
    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      priority: Number(priority) || 100,
      isActive,
      conditions: {
        ...(channel ? { channel: splitCsv(channel) } : {}),
        ...(destCountry ? { destinationCountry: splitCsv(destCountry) } : {}),
        ...(weightMin ? { weightGramsMin: Number(weightMin) } : {}),
        ...(weightMax ? { weightGramsMax: Number(weightMax) } : {}),
        ...(isPrime === 'yes' ? { isPrime: true } : isPrime === 'no' ? { isPrime: false } : {}),
      },
      actions: {
        ...(carrier ? { preferCarrierCode: carrier } : {}),
        ...(service ? { preferServiceCode: service } : {}),
        ...(requireSig ? { requireSignature: true } : {}),
        ...(requireIns ? { requireInsurance: true } : {}),
        ...(holdReview ? { holdForReview: true } : {}),
      },
    }
    try {
      const url = isNew
        ? `${getBackendUrl()}/api/fulfillment/shipping-rules`
        : `${getBackendUrl()}/api/fulfillment/shipping-rules/${rule!.id}`
      const res = await fetch(url, {
        method: isNew ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(err.error ?? 'Save failed')
        return
      }
      toast.success(isNew ? 'Rule created' : 'Rule updated')
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/30 flex justify-end" onClick={onClose} role="dialog" aria-modal="true">
      <div className="w-full max-w-[640px] bg-white shadow-2xl border-l border-slate-200 flex flex-col h-full" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 py-4 border-b border-slate-200">
          <div className="flex-1">
            <h2 className="text-lg font-semibold text-slate-900">{isNew ? 'New shipping rule' : 'Edit rule'}</h2>
            <div className="text-sm text-slate-500">WHEN conditions match → THEN actions apply</div>
          </div>
          <button onClick={onClose} className="h-8 w-8 inline-flex items-center justify-center text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded">
            <X size={16} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <Section title="Identity">
            <Field label="Name" required>
              <input value={name} onChange={(e) => setName(e.target.value)} className="px-3 h-9 text-md border border-slate-300 rounded outline-none focus:border-blue-500 w-full" placeholder='e.g. "Heavy IT → DHL"' />
            </Field>
            <Field label="Description (optional)">
              <input value={description} onChange={(e) => setDescription(e.target.value)} className="px-3 h-9 text-md border border-slate-300 rounded outline-none focus:border-blue-500 w-full" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Priority (lower = first)">
                <input type="number" value={priority} onChange={(e) => setPriority(e.target.value)} className="px-3 h-9 text-md tabular-nums border border-slate-300 rounded outline-none focus:border-blue-500 w-full" />
              </Field>
              <Field label="Active">
                <label className="inline-flex items-center gap-2 h-9 text-md">
                  <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
                  <span className="text-slate-700">{isActive ? 'enabled' : 'disabled'}</span>
                </label>
              </Field>
            </div>
          </Section>

          <Section title="When (conditions)">
            <Field label="Channel (comma list — empty = any)">
              <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder={CHANNEL_OPTIONS.join(', ')} className="px-3 h-9 text-md border border-slate-300 rounded outline-none focus:border-blue-500 w-full font-mono" />
            </Field>
            <Field label="Destination country (comma ISO-2 — empty = any)">
              <input value={destCountry} onChange={(e) => setDestCountry(e.target.value)} placeholder="IT, DE, FR" className="px-3 h-9 text-md border border-slate-300 rounded outline-none focus:border-blue-500 w-full font-mono" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Weight min (grams)">
                <input type="number" value={weightMin} onChange={(e) => setWeightMin(e.target.value)} className="px-3 h-9 text-md tabular-nums border border-slate-300 rounded outline-none focus:border-blue-500 w-full" />
              </Field>
              <Field label="Weight max (grams)">
                <input type="number" value={weightMax} onChange={(e) => setWeightMax(e.target.value)} className="px-3 h-9 text-md tabular-nums border border-slate-300 rounded outline-none focus:border-blue-500 w-full" />
              </Field>
            </div>
            <Field label="Amazon Prime">
              <select value={isPrime} onChange={(e) => setIsPrime(e.target.value as any)} className="px-3 h-9 text-md border border-slate-300 rounded bg-white">
                <option value="any">any</option>
                <option value="yes">Prime only</option>
                <option value="no">non-Prime only</option>
              </select>
            </Field>
          </Section>

          <Section title="Then (actions)">
            <Field label="Prefer carrier">
              <select value={carrier} onChange={(e) => setCarrier(e.target.value)} className="px-3 h-9 text-md border border-slate-300 rounded bg-white w-full">
                <option value="">— no override —</option>
                {CARRIER_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Prefer service code (optional)">
              <input value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. STANDARD or BRT_BUSINESS" className="px-3 h-9 text-md border border-slate-300 rounded outline-none focus:border-blue-500 w-full font-mono" />
            </Field>
            <div className="space-y-1.5">
              <label className="inline-flex items-center gap-2 text-md text-slate-700">
                <input type="checkbox" checked={requireSig} onChange={(e) => setRequireSig(e.target.checked)} />
                Require signature
              </label>
              <label className="inline-flex items-center gap-2 text-md text-slate-700">
                <input type="checkbox" checked={requireIns} onChange={(e) => setRequireIns(e.target.checked)} />
                Require insurance
              </label>
              <label className="inline-flex items-center gap-2 text-md text-slate-700">
                <input type="checkbox" checked={holdReview} onChange={(e) => setHoldReview(e.target.checked)} />
                Hold for manual review
              </label>
            </div>
          </Section>
        </div>
        <div className="flex items-center gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50">
          <button onClick={submit} disabled={saving} className="h-9 px-4 text-md bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1.5">
            {isNew ? 'Create rule' : 'Save changes'}
          </button>
          <button onClick={onClose} className="h-9 px-3 text-md text-slate-700 hover:bg-white border border-slate-200 rounded">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-sm font-semibold text-slate-700 uppercase tracking-wider">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function Field({ label, children, required = false }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-slate-500">
        {label}
        {required && <span className="text-rose-500 ml-0.5">*</span>}
      </span>
      {children}
    </label>
  )
}
