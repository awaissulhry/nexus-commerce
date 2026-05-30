'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Plus, Trash2, Sparkles, RefreshCw, Play, Eye, CheckCircle2,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { IconButton } from '@/components/ui/IconButton'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Skeleton } from '@/components/ui/Skeleton'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { COUNTRY_NAMES } from '@/lib/country-names'
import { getBackendUrl } from '@/lib/backend-url'
import { ReviewsNav } from '../../../marketing/reviews/_shared/ReviewsNav'

type Rule = {
  id: string
  name: string
  scope: string
  marketplace: string | null
  isActive: boolean
  minDaysSinceDelivery: number
  maxDaysSinceDelivery: number
  exclusions: string[]
  minOrderTotalCents: number | null
  notes: string | null
  requestCount: number
  useSentimentDiversion?: boolean
}

const SCOPES: Array<{ value: string; label: string; helpText: string }> = [
  { value: 'AMAZON_PER_MARKETPLACE', label: 'Amazon — per marketplace', helpText: 'Pick a specific Amazon marketplace (IT/DE/FR/…). Recommended for fine-tuning rules per region.' },
  { value: 'AMAZON_GLOBAL', label: 'Amazon — all marketplaces', helpText: 'Apply to every Amazon marketplace at once. Easier setup, less control.' },
  { value: 'EBAY', label: 'eBay', helpText: 'Track eBay reviews (auto-feedback after 7 days). Mostly observational.' },
  { value: 'SHOPIFY', label: 'Shopify', helpText: 'Track-only until you wire Yotpo / Loox / Judge.me.' },
  { value: 'WOOCOMMERCE', label: 'WooCommerce', helpText: 'Track-only until a third-party app is wired.' },
  { value: 'ETSY', label: 'Etsy', helpText: 'Etsy auto-requests reviews 7d post-delivery.' },
  { value: 'MANUAL', label: 'Manual / Other', helpText: 'For offline orders or other channels.' },
]

const EXCLUSIONS: Array<{ value: string; label: string }> = [
  { value: 'has_active_return', label: 'Has active return' },
  { value: 'has_refund', label: 'Has refund' },
  { value: 'fba_only', label: 'FBA only (excludes FBM)' },
  { value: 'fbm_only', label: 'FBM only (excludes FBA)' },
]

const PRESETS = [
  {
    name: 'Amazon — all markets default',
    scope: 'AMAZON_GLOBAL',
    minDays: 7, maxDays: 25,
    exclusions: ['has_active_return', 'has_refund'],
    notes: 'Covers IT + DE + FR + ES + UK + every other Amazon marketplace at once. One rule to rule them all. Easiest setup.',
  },
  {
    name: 'Amazon — safe default',
    scope: 'AMAZON_PER_MARKETPLACE',
    minDays: 7, maxDays: 25,
    exclusions: ['has_active_return', 'has_refund'],
    notes: 'Recommended starting point. Excludes any order with an active return or refund.',
  },
  {
    name: 'Amazon — aggressive 5d',
    scope: 'AMAZON_PER_MARKETPLACE',
    minDays: 5, maxDays: 28,
    exclusions: ['has_active_return', 'has_refund'],
    notes: 'Sends earlier (5d) but still excludes returns + refunds.',
  },
  {
    name: 'Amazon FBA only — careful',
    scope: 'AMAZON_PER_MARKETPLACE',
    minDays: 10, maxDays: 25,
    exclusions: ['has_active_return', 'has_refund', 'fbm_only'],
    notes: 'FBA-only orders, longer wait window for delivery confirmation.',
  },
]

const AMAZON_MARKETPLACES = ['IT', 'DE', 'FR', 'ES', 'UK', 'NL', 'PL', 'SE', 'BE', 'TR']

export default function RulesClient() {
  const askConfirm = useConfirm()
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Rule | null>(null)
  const [creating, setCreating] = useState(false)
  const [previewRule, setPreviewRule] = useState<Rule | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/review-rules`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setRules(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { refresh() }, [refresh])

  const remove = async (id: string) => {
    if (!(await askConfirm({ title: 'Delete this rule?', confirmLabel: 'Delete', tone: 'danger' }))) return
    await fetch(`${getBackendUrl()}/api/review-rules/${id}`, { method: 'DELETE' })
    refresh()
  }

  // RV.9.1 — detect the state where automation is *configured* but won't
  // fire for some/all Amazon markets. Three cases:
  //   1. No rule at all OR no rule covering Amazon orders → show full banner.
  //   2. A rule with scope=AMAZON_PER_MARKETPLACE has marketplace=null
  //      (broken — matches no orders).
  //   3. Only an IT rule exists → suggest expanding to all markets.
  const activeGlobalRule = rules.find(
    (r) => r.isActive && r.scope === 'AMAZON_GLOBAL',
  )
  const activeItRule = rules.find(
    (r) => r.isActive && r.scope === 'AMAZON_PER_MARKETPLACE' && r.marketplace === 'IT',
  )
  const brokenRule = rules.find(
    (r) => r.scope === 'AMAZON_PER_MARKETPLACE' && !r.marketplace,
  )
  // Amazon orders covered iff a global rule is active OR an IT rule is
  // active. Show the banner unless one of those holds.
  const someAmazonCoverage = !!activeGlobalRule || !!activeItRule
  const showSetupBanner = !someAmazonCoverage || !!brokenRule
  // RV.9.1 follow-up — even when an IT rule is in place, suggest
  // expanding to global since DE/FR/ES/etc. delivered orders never
  // create ReviewRequest rows.
  const suggestExpand = !!activeItRule && !activeGlobalRule

  const seedDefault = async (scope?: 'AMAZON_GLOBAL') => {
    try {
      const qs = scope ? `?scope=${scope}` : ''
      const res = await fetch(`${getBackendUrl()}/api/review-rules/seed-default${qs}`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      refresh()
    } catch (e: any) {
      alert(`Couldn't seed: ${e.message}`)
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Review request rules"
        description="Per-channel and per-marketplace rules that drive automatic Amazon Solicitations. Excluded orders never get a request."
        breadcrumbs={[{ label: 'Marketing', href: '/marketing/reviews' }, { label: 'Reviews', href: '/marketing/reviews' }, { label: 'Rules' }]}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="h-8 px-3 text-sm font-semibold bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 dark:hover:bg-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 inline-flex items-center gap-1.5"
            >
              <Plus size={12} /> New rule
            </button>
            <button
              type="button"
              onClick={refresh}
              className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 inline-flex items-center gap-1.5"
            >
              <RefreshCw size={12} /> Refresh
            </button>
          </div>
        }
      />

      {/* RX.0 — bridge into the shared reviews workspace nav */}
      <ReviewsNav />

      {/* RV.9.1 — setup nudge banner */}
      {!loading && showSetupBanner && (
        <div className="rounded-md border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 flex items-start gap-3">
          <Sparkles className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            {brokenRule ? (
              <>
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                  Rule &quot;{brokenRule.name}&quot; is misconfigured
                </div>
                <div className="text-xs text-amber-800 dark:text-amber-200 mt-0.5">
                  Scope is <strong>AMAZON_PER_MARKETPLACE</strong> but no marketplace is set — this rule matches zero orders. Repair it to <strong>IT</strong> or switch to a global rule covering every market.
                </div>
              </>
            ) : (
              <>
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-100">No active Amazon rule</div>
                <div className="text-xs text-amber-800 dark:text-amber-200 mt-0.5">
                  Without an active rule the automation never schedules review requests. Pick the recommended <strong>all-markets default</strong> (covers IT + DE + FR + ES + UK + every other Amazon marketplace at once) or an IT-only rule.
                </div>
              </>
            )}
          </div>
          <div className="flex flex-col gap-1.5 shrink-0">
            <button
              onClick={() => seedDefault('AMAZON_GLOBAL')}
              className="h-8 px-3 text-sm font-semibold bg-amber-600 text-white rounded hover:bg-amber-700 whitespace-nowrap"
            >
              Set up all-markets default
            </button>
            <button
              onClick={() => seedDefault()}
              className="h-7 px-3 text-xs font-medium bg-white text-amber-800 border border-amber-300 rounded hover:bg-amber-50 dark:bg-slate-900 dark:text-amber-200 dark:border-amber-800 whitespace-nowrap"
            >
              {brokenRule ? 'Repair to IT only' : 'Set up IT only'}
            </button>
          </div>
        </div>
      )}

      {/* RV.9.1 follow-up — even with an IT rule, suggest expanding to global.
          Quiet sky-blue banner; not an error state, just a hint. */}
      {!loading && suggestExpand && (
        <div className="rounded-md border border-sky-200 dark:border-sky-900 bg-sky-50 dark:bg-sky-950/30 px-4 py-2.5 flex items-start gap-3">
          <Sparkles className="h-4 w-4 text-sky-600 dark:text-sky-400 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="text-xs text-sky-900 dark:text-sky-200">
              Only the <strong>IT</strong> rule is active — delivered orders from DE / FR / ES / UK / other Amazon markets are never scheduled. Add an <strong>all-markets default</strong> to cover them too. (Per-market still wins for IT — they coexist.)
            </div>
          </div>
          <button
            onClick={() => seedDefault('AMAZON_GLOBAL')}
            className="h-7 px-2.5 text-xs font-medium bg-sky-600 text-white rounded hover:bg-sky-700 shrink-0 whitespace-nowrap"
          >
            Expand to all markets
          </button>
        </div>
      )}

      {loading && rules.length === 0 ? <Card><Skeleton lines={6} /></Card> :
        rules.length === 0 ? (
          <Card>
            <div className="text-center py-6 space-y-3">
              <Sparkles className="text-amber-500 mx-auto" size={32} />
              <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">No rules yet</div>
              <div className="text-base text-slate-500 dark:text-slate-400">Pick a preset to get started, or create from scratch.</div>
              <div className="flex items-center justify-center gap-2 pt-3 flex-wrap">
                {PRESETS.map((p) => (
                  <button
                    key={p.name}
                    onClick={() => setCreating(true)}
                    className="h-8 px-3 text-base bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-900 rounded hover:bg-blue-100 dark:hover:bg-blue-900/60"
                  >+ {p.name}</button>
                ))}
              </div>
            </div>
          </Card>
        ) : (
          <Card noPadding>
            <div className="overflow-x-auto">
              <table className="w-full text-md">
                <thead className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">Name</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">Scope</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">Window</th>
                    <th className="px-3 py-2 text-left text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">Exclusions</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700 dark:text-slate-300">Sent</th>
                    <th className="px-3 py-2 text-right text-sm font-semibold uppercase text-slate-700 dark:text-slate-300"></th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800">
                      <td className="px-3 py-2">
                        <div className="text-md font-medium text-slate-900 dark:text-slate-100">{r.name}</div>
                        {r.notes && <div className="text-xs text-slate-500 dark:text-slate-400 truncate max-w-md">{r.notes}</div>}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant="info" size="sm">{SCOPES.find((s) => s.value === r.scope)?.label ?? r.scope}</Badge>
                        {r.marketplace && <span className="ml-1 text-xs font-mono bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5 rounded text-slate-700 dark:text-slate-300">{r.marketplace}</span>}
                      </td>
                      <td className="px-3 py-2 text-base text-slate-700 dark:text-slate-300 tabular-nums">{r.minDaysSinceDelivery}–{r.maxDaysSinceDelivery}d</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1 flex-wrap">
                          {r.exclusions.map((e) => (
                            <span key={e} className="text-xs font-mono bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 px-1.5 py-0.5 rounded">{e}</span>
                          ))}
                          {r.exclusions.length === 0 && <span className="text-xs text-slate-400 dark:text-slate-500">none</span>}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-base text-slate-700 dark:text-slate-300">{r.requestCount}</td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center gap-1 justify-end">
                          <button onClick={() => setPreviewRule(r)} title="Dry run" className="h-6 px-2 text-sm text-slate-600 dark:text-slate-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950/40 rounded inline-flex items-center gap-1">
                            <Eye size={11} /> Preview
                          </button>
                          <button onClick={() => setEditing(r)} title="Edit" className="h-6 px-2 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 rounded">Edit</button>
                          <IconButton
                            aria-label={`Delete rule ${r.name}`}
                            tone="danger"
                            size="sm"
                            onClick={() => remove(r.id)}
                          >
                            <Trash2 size={12} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      }

      {(creating || editing) && (
        <RuleEditor
          rule={editing}
          onClose={() => { setCreating(false); setEditing(null) }}
          onSaved={() => { setCreating(false); setEditing(null); refresh() }}
        />
      )}

      {previewRule && (
        <PreviewModal rule={previewRule} onClose={() => setPreviewRule(null)} onRun={() => { setPreviewRule(null); refresh() }} />
      )}
    </div>
  )
}

function RuleEditor({ rule, onClose, onSaved }: { rule: Rule | null; onClose: () => void; onSaved: () => void }) {
  const { toast } = useToast()
  const [name, setName] = useState(rule?.name ?? '')
  const [scope, setScope] = useState(rule?.scope ?? 'AMAZON_PER_MARKETPLACE')
  const [marketplace, setMarketplace] = useState(rule?.marketplace ?? 'IT')
  const [isActive, setIsActive] = useState(rule?.isActive ?? true)
  const [minDays, setMinDays] = useState(rule?.minDaysSinceDelivery ?? 7)
  const [maxDays, setMaxDays] = useState(rule?.maxDaysSinceDelivery ?? 25)
  const [exclusions, setExclusions] = useState<string[]>(rule?.exclusions ?? ['has_active_return', 'has_refund'])
  const [minOrderTotal, setMinOrderTotal] = useState<string>(rule?.minOrderTotalCents != null ? (rule.minOrderTotalCents / 100).toFixed(2) : '')
  const [notes, setNotes] = useState(rule?.notes ?? '')
  const [useSentimentDiversion, setUseSentimentDiversion] = useState<boolean>(rule?.useSentimentDiversion ?? false)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (!name.trim()) { toast.error('Name required'); return }
    if (scope === 'AMAZON_PER_MARKETPLACE' && !marketplace) { toast.error('Marketplace required'); return }
    setBusy(true)
    try {
      const body = {
        name, scope,
        marketplace: scope === 'AMAZON_PER_MARKETPLACE' ? marketplace : null,
        isActive,
        minDaysSinceDelivery: minDays,
        maxDaysSinceDelivery: maxDays,
        exclusions,
        minOrderTotalCents: minOrderTotal ? Math.round(Number(minOrderTotal) * 100) : null,
        notes: notes || null,
        useSentimentDiversion,
      }
      const res = await fetch(`${getBackendUrl()}/api/review-rules${rule ? `/${rule.id}` : ''}`, {
        method: rule ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSaved()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setBusy(false) }
  }

  const toggleExclusion = (v: string) => {
    setExclusions(exclusions.includes(v) ? exclusions.filter((e) => e !== v) : [...exclusions, v])
  }

  const applyPreset = (p: typeof PRESETS[number]) => {
    setName(p.name)
    setScope(p.scope)
    setMinDays(p.minDays)
    setMaxDays(p.maxDays)
    setExclusions([...p.exclusions])
    setNotes(p.notes)
  }

  const scopeHelp = SCOPES.find((s) => s.value === scope)?.helpText

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles size={16} /> {rule ? 'Edit rule' : 'New rule'}
        </span>
      }
    >
      <ModalBody className="space-y-4">
          {!rule && (
            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded p-3">
              <div className="text-sm font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300 mb-2">Start from a preset</div>
              <div className="flex items-center gap-1.5 flex-wrap">
                {PRESETS.map((p) => (
                  <button key={p.name} onClick={() => applyPreset(p)} className="h-7 px-2 text-sm bg-white dark:bg-slate-900 text-blue-700 dark:text-blue-300 border border-blue-300 rounded hover:bg-blue-50 dark:hover:bg-blue-950/40">
                    {p.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Amazon IT — safe 7d" className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded mt-1" />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Scope</label>
              <select value={scope} onChange={(e) => setScope(e.target.value)} className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded mt-1">
                {SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
              {scopeHelp && <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">{scopeHelp}</div>}
            </div>
            {scope === 'AMAZON_PER_MARKETPLACE' && (
              <div>
                <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Marketplace</label>
                <select value={marketplace} onChange={(e) => setMarketplace(e.target.value)} className="w-full h-8 px-2 text-md border border-slate-200 dark:border-slate-700 rounded mt-1">
                  {AMAZON_MARKETPLACES.map((m) => <option key={m} value={m}>{m} · {COUNTRY_NAMES[m] ?? ''}</option>)}
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Send window (days post-delivery)</label>
            <div className="flex items-center gap-2 mt-1">
              <input type="number" min="4" max="30" value={minDays} onChange={(e) => setMinDays(Math.max(4, Math.min(30, Number(e.target.value) || 7)))} className="w-20 h-8 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-md" />
              <span className="text-sm text-slate-500 dark:text-slate-400">to</span>
              <input type="number" min="4" max="30" value={maxDays} onChange={(e) => setMaxDays(Math.max(4, Math.min(30, Number(e.target.value) || 25)))} className="w-20 h-8 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-md" />
              <span className="text-xs text-slate-500 dark:text-slate-400">Amazon caps at 4–30 days</span>
            </div>
          </div>

          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Exclusions</label>
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {EXCLUSIONS.map((e) => {
                const active = exclusions.includes(e.value)
                return (
                  <button key={e.value} onClick={() => toggleExclusion(e.value)} className={`h-7 px-2 text-sm border rounded ${active ? 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'}`}>
                    {active && <CheckCircle2 size={10} className="inline mr-1" />}
                    {e.label}
                  </button>
                )
              })}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">Orders matching ANY exclusion will be suppressed (skipped from this rule).</div>
          </div>

          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Min order total (€, optional)</label>
            <input type="number" step="0.01" value={minOrderTotal} onChange={(e) => setMinOrderTotal(e.target.value)} placeholder="0.00" className="w-32 h-8 px-2 text-right tabular-nums border border-slate-200 dark:border-slate-700 rounded text-md mt-1" />
            <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">Skip low-value orders below this gross.</div>
          </div>

          <div>
            <label className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">Notes</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full h-16 px-2 py-1.5 text-base border border-slate-200 dark:border-slate-700 rounded mt-1" />
          </div>

          {/* RV.6.5 — Negative-feedback diversion toggle */}
          <div className="rounded border border-slate-200 dark:border-slate-700 p-3 bg-slate-50/50 dark:bg-slate-950/30">
            <label className="flex items-start gap-2 text-base text-slate-700 dark:text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={useSentimentDiversion}
                onChange={(e) => setUseSentimentDiversion(e.target.checked)}
                className="mt-1"
              />
              <div>
                <div className="font-medium">Use negative-feedback diversion (review funnel)</div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  Before the Amazon Solicitations API call, send a branded
                  &quot;How was it?&quot; email with two buttons. Happy customers
                  proceed to the normal review request; unhappy ones are
                  routed to your support inbox before they leave a public
                  1-star. Standard rating-lift technique used by major sellers.
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                  <span className="font-medium">Timing:</span> sentiment email fires at
                  delivered + {minDays}d. If no response within 5d, fallback
                  fires the Amazon Solicitations directly.
                </div>
              </div>
            </label>
          </div>

          <label className="flex items-center gap-2 text-base text-slate-700 dark:text-slate-300">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
            Rule is active (the engine includes inactive rules in dry-runs but never sends from them)
          </label>
      </ModalBody>
      <ModalFooter>
        {/* Cancel/Save — explicit colours + the new app-wide disabled
            state so neither button collapses to a transparent ghost
            (was: native <button> + low-contrast white-on-white outline
            for Cancel and slate-on-slate text for Save). */}
        <button
          type="button"
          onClick={onClose}
          className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="h-8 px-3 text-sm font-semibold bg-slate-900 text-white border border-slate-900 rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100 dark:hover:bg-slate-200 disabled:cursor-not-allowed disabled:!bg-slate-200 disabled:!text-slate-500 disabled:!border-slate-200 disabled:dark:!bg-slate-700 disabled:dark:!text-slate-400 disabled:dark:!border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {rule ? 'Save changes' : 'Create rule'}
        </button>
      </ModalFooter>
    </Modal>
  )
}

function PreviewModal({ rule, onClose, onRun }: { rule: Rule; onClose: () => void; onRun: () => void }) {
  const { toast } = useToast()
  const askConfirm = useConfirm()
  const [data, setData] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/review-rules/${rule.id}/dry-run`, { method: 'POST' })
      .then((r) => r.json())
      .then(setData)
      .finally(() => setLoading(false))
  }, [rule.id])

  const runIt = async () => {
    if (!(await askConfirm({ title: `Enqueue ${data?.matchCount ?? 0} review requests?`, description: 'They run on the next engine tick.', confirmLabel: 'Enqueue', tone: 'info' }))) return
    setRunning(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/review-rules/${rule.id}/run`, { method: 'POST' })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      toast.success(`Enqueued ${d.enqueued}, skipped ${d.skipped} (already requested)`)
      onRun()
    } catch (e: any) {
      toast.error(e.message)
    } finally { setRunning(false) }
  }

  return (
    <Modal
      open
      onClose={onClose}
      size="2xl"
      title={
        <span className="inline-flex items-center gap-2">
          <Eye size={16} /> Dry run — {rule.name}
        </span>
      }
    >
      <ModalBody className="space-y-3">
        {loading ? <div className="text-md text-slate-500 dark:text-slate-400 py-4 text-center">Computing matches…</div> : !data ? (
          <div className="text-md text-rose-600 dark:text-rose-400">Failed to load dry-run.</div>
        ) : (
          <>
            <div className="bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900 rounded p-3">
              <div className="text-[24px] font-semibold text-blue-700 dark:text-blue-300 tabular-nums">{data.matchCount}</div>
              <div className="text-sm uppercase tracking-wider text-blue-700 dark:text-blue-300 font-semibold">orders match this rule today</div>
            </div>
            {data.sample.length === 0 ? (
              <div className="text-base text-slate-500 dark:text-slate-400 text-center py-4">No matches.</div>
            ) : (
              <div>
                <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">Sample (first 25)</div>
                <ul className="space-y-1 -my-1">
                  {data.sample.map((s: any) => (
                    <li key={s.orderId} className="flex items-center justify-between gap-2 py-1.5 px-2 -mx-2 rounded hover:bg-slate-50 dark:hover:bg-slate-800">
                      <Link href={`/orders/${s.orderId}`} className="text-base font-mono text-blue-600 dark:text-blue-400 hover:underline">{s.channelOrderId}</Link>
                      <span className="text-sm text-slate-500 dark:text-slate-400">{s.customerEmail}</span>
                      <span className="text-sm tabular-nums text-slate-700 dark:text-slate-300">€{Number(s.totalPrice).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </ModalBody>
      {data && (
        <ModalFooter>
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-3 text-sm font-medium bg-white text-slate-900 border border-slate-300 rounded-md hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-100 dark:border-slate-600 dark:hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            Close
          </button>
          <button
            type="button"
            onClick={runIt}
            disabled={running || data.matchCount === 0}
            className="h-8 px-3 text-sm font-semibold bg-emerald-600 text-white border border-emerald-600 rounded-md hover:bg-emerald-700 dark:bg-emerald-700 dark:border-emerald-700 dark:hover:bg-emerald-800 disabled:cursor-not-allowed disabled:!bg-slate-200 disabled:!text-slate-500 disabled:!border-slate-200 disabled:dark:!bg-slate-700 disabled:dark:!text-slate-400 disabled:dark:!border-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 inline-flex items-center gap-1.5"
          >
            <Play size={12} /> Enqueue all {data.matchCount}
          </button>
        </ModalFooter>
      )}
    </Modal>
  )
}
