'use client'

// C.16 — eBay Promoted Listings campaign manager.
//
// CRUD UI on top of EbayCampaign (C.14 schema). Shows the operator's
// campaigns scoped to their connected eBay accounts, supports
// create / pause / resume / end / delete flows.
//
// Local persistence only for v1: campaigns sit in EbayCampaign with
// status='DRAFT' until the operator manually flips them to 'RUNNING'
// (acknowledging they've created the campaign on eBay's side via
// Seller Hub). The Marketing API push lands behind
// NEXUS_ENABLE_EBAY_PUBLISH in a follow-up commit. The banner at the
// top of the page is honest about this gap so the operator doesn't
// expect a Nexus-side create to surface on eBay automatically.

import { useState, useMemo } from 'react'
import { Plus, Play, Pause, Square, Trash2, AlertCircle } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Skeleton } from '@/components/ui/Skeleton'
import { Modal, ModalBody, ModalFooter } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { getBackendUrl } from '@/lib/backend-url'
import { usePolledList } from '@/lib/sync/use-polled-list'

const EBAY_MARKETPLACES = [
  { id: 'EBAY_IT', label: 'Italy (EBAY_IT)' },
  { id: 'EBAY_DE', label: 'Germany (EBAY_DE)' },
  { id: 'EBAY_ES', label: 'Spain (EBAY_ES)' },
  { id: 'EBAY_FR', label: 'France (EBAY_FR)' },
  { id: 'EBAY_GB', label: 'United Kingdom (EBAY_GB)' },
]

interface EbayCampaign {
  id: string
  channelConnectionId: string
  marketplace: string
  externalCampaignId: string
  name: string
  fundingStrategy: 'STANDARD' | 'ADVANCED'
  bidPercentage: number | null
  dailyBudget: number | null
  budgetCurrency: string | null
  status: 'DRAFT' | 'RUNNING' | 'PAUSED' | 'ENDED'
  startDate: string
  endDate: string | null
  impressions: number
  clicks: number
  sales: number
  spend: number
  metricsAt: string | null
  createdAt: string
  updatedAt: string
}

const STATUS_TONE: Record<string, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 border-slate-200',
  RUNNING: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  PAUSED: 'bg-amber-50 text-amber-700 border-amber-200',
  ENDED: 'bg-slate-50 text-slate-400 border-slate-200',
}

export default function EbayCampaignsClient() {
  const [marketplaceFilter, setMarketplaceFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [createOpen, setCreateOpen] = useState(false)
  const { toast } = useToast()
  const askConfirm = useConfirm()

  const url = useMemo(() => {
    const qs = new URLSearchParams()
    if (marketplaceFilter) qs.set('marketplace', marketplaceFilter)
    if (statusFilter) qs.set('status', statusFilter)
    return `/api/listings/ebay/campaigns?${qs.toString()}`
  }, [marketplaceFilter, statusFilter])

  const { data, loading, error, refetch } = usePolledList<{
    campaigns: EbayCampaign[]
  }>({
    url,
    intervalMs: 30_000,
  })

  const campaigns = data?.campaigns ?? []

  const transition = async (
    id: string,
    nextStatus: 'RUNNING' | 'PAUSED' | 'ENDED',
  ) => {
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/ebay/campaigns/${id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: nextStatus }),
        },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success(`Campaign ${nextStatus.toLowerCase()}`)
      refetch()
    } catch (e: any) {
      toast.error(`Update failed: ${e?.message ?? String(e)}`)
    }
  }

  const remove = async (campaign: EbayCampaign) => {
    if (campaign.status !== 'DRAFT') {
      toast.error(
        'Only DRAFT campaigns can be deleted. Use End to preserve metrics history.',
      )
      return
    }
    const ok = await askConfirm({
      title: `Delete campaign "${campaign.name}"?`,
      description: 'This DRAFT campaign will be removed permanently. Active and ended campaigns must be ended via the End button instead.',
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listings/ebay/campaigns/${campaign.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success('Campaign deleted')
      refetch()
    } catch (e: any) {
      toast.error(`Delete failed: ${e?.message ?? String(e)}`)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Promoted Listings campaigns"
        description="eBay Promoted Listings — Standard CPM (bid percentage) or Advanced CPC (daily budget). Manage campaigns + track performance."
        breadcrumbs={[
          { label: 'Listings', href: '/listings' },
          { label: 'eBay', href: '/listings/ebay' },
          { label: 'Campaigns' },
        ]}
      />

      {/* Honest banner — no auto-push to eBay yet. */}
      <Card>
        <div className="flex items-start gap-2 text-sm">
          <AlertCircle size={14} className="mt-0.5 text-amber-600 flex-shrink-0" />
          <div className="text-slate-600">
            <span className="font-semibold text-slate-700">eBay push pending —</span>{' '}
            campaigns are stored in Nexus only for now. Create the matching campaign on
            eBay&apos;s Seller Hub side, then flip status to <code className="px-1 bg-slate-100 rounded text-xs">RUNNING</code> here
            so metrics tracking lines up. Direct push to eBay&apos;s Marketing API
            lands behind <code className="px-1 bg-slate-100 rounded text-xs">NEXUS_ENABLE_EBAY_PUBLISH</code> in a
            follow-up commit.
          </div>
        </div>
      </Card>

      {/* Filters + Create */}
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={marketplaceFilter}
          onChange={(e) => setMarketplaceFilter(e.target.value)}
          className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
          aria-label="Filter by marketplace"
        >
          <option value="">All marketplaces</option>
          {EBAY_MARKETPLACES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="h-8 px-2 text-base bg-white border border-slate-200 rounded text-slate-700 hover:border-slate-300 focus:outline-none focus:border-blue-500"
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="RUNNING">Running</option>
          <option value="PAUSED">Paused</option>
          <option value="ENDED">Ended</option>
        </select>
        <span className="text-sm text-slate-500 ml-2">
          {campaigns.length} campaign{campaigns.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={() => setCreateOpen(true)}
          className="ml-auto h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5"
        >
          <Plus size={12} /> New campaign
        </button>
      </div>

      {/* List */}
      {loading && !data ? (
        <Card>
          <Skeleton variant="text" lines={4} />
        </Card>
      ) : error && !data ? (
        <Card>
          <div className="text-rose-600 text-sm">Failed to load: {error}</div>
        </Card>
      ) : campaigns.length === 0 ? (
        <Card>
          <div className="text-center py-8 text-sm text-slate-500">
            No campaigns yet.{' '}
            <button
              onClick={() => setCreateOpen(true)}
              className="text-blue-600 hover:underline"
            >
              Create your first campaign
            </button>
            .
          </div>
        </Card>
      ) : (
        <Card noPadding>
          <table className="w-full text-base">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Name</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Market</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Funding</th>
                <th className="text-left px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Status</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Spend</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Sales</th>
                <th className="text-right px-3 py-2 text-sm font-semibold text-slate-700 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => (
                <tr key={c.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-xs text-slate-500 font-mono">
                      {c.externalCampaignId.startsWith('local-')
                        ? '(not yet pushed to eBay)'
                        : c.externalCampaignId}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    <span className="font-mono">{c.marketplace.replace('EBAY_', '')}</span>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {c.fundingStrategy === 'STANDARD' ? (
                      <span>
                        CPM <span className="font-semibold tabular-nums">{c.bidPercentage?.toFixed(2)}%</span>
                      </span>
                    ) : (
                      <span>
                        CPC <span className="font-semibold tabular-nums">
                          {c.dailyBudget?.toFixed(2)} {c.budgetCurrency}/day
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`inline-block text-xs font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${STATUS_TONE[c.status] ?? ''}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm">
                    {c.spend > 0 ? c.spend.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-sm">
                    {c.sales > 0 ? c.sales.toFixed(2) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="inline-flex items-center gap-1">
                      {(c.status === 'DRAFT' || c.status === 'PAUSED') && (
                        <button
                          onClick={() => transition(c.id, 'RUNNING')}
                          title="Start / resume"
                          aria-label={`Start campaign "${c.name}"`}
                          className="h-7 w-7 inline-flex items-center justify-center text-emerald-600 hover:bg-emerald-50 rounded focus:outline-none focus:ring-2 focus:ring-emerald-300"
                        >
                          <Play size={12} />
                        </button>
                      )}
                      {c.status === 'RUNNING' && (
                        <button
                          onClick={() => transition(c.id, 'PAUSED')}
                          title="Pause"
                          aria-label={`Pause campaign "${c.name}"`}
                          className="h-7 w-7 inline-flex items-center justify-center text-amber-600 hover:bg-amber-50 rounded focus:outline-none focus:ring-2 focus:ring-amber-300"
                        >
                          <Pause size={12} />
                        </button>
                      )}
                      {c.status !== 'ENDED' && (
                        <button
                          onClick={() => transition(c.id, 'ENDED')}
                          title="End campaign"
                          aria-label={`End campaign "${c.name}"`}
                          className="h-7 w-7 inline-flex items-center justify-center text-slate-500 hover:bg-slate-100 rounded focus:outline-none focus:ring-2 focus:ring-slate-300"
                        >
                          <Square size={12} />
                        </button>
                      )}
                      {c.status === 'DRAFT' && (
                        <button
                          onClick={() => remove(c)}
                          title="Delete"
                          aria-label={`Delete DRAFT campaign "${c.name}"`}
                          className="h-7 w-7 inline-flex items-center justify-center text-rose-500 hover:bg-rose-50 rounded focus:outline-none focus:ring-2 focus:ring-rose-300"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {createOpen && (
        <CreateCampaignModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false)
            refetch()
          }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
// CreateCampaignModal — name + marketplace + funding strategy + start
// ────────────────────────────────────────────────────────────────────
function CreateCampaignModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [marketplace, setMarketplace] = useState('EBAY_IT')
  const [fundingStrategy, setFundingStrategy] = useState<'STANDARD' | 'ADVANCED'>('STANDARD')
  const [bidPercentage, setBidPercentage] = useState('5.00')
  const [dailyBudget, setDailyBudget] = useState('20.00')
  const [budgetCurrency, setBudgetCurrency] = useState('EUR')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const body: any = {
        name: name.trim(),
        marketplace,
        fundingStrategy,
        startDate,
        endDate: endDate || null,
      }
      if (fundingStrategy === 'STANDARD') {
        body.bidPercentage = Number(bidPercentage)
      } else {
        body.dailyBudget = Number(dailyBudget)
        body.budgetCurrency = budgetCurrency
      }
      const res = await fetch(`${getBackendUrl()}/api/listings/ebay/campaigns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      toast.success('Campaign created (DRAFT). Flip to RUNNING when you push it on eBay.')
      onCreated()
    } catch (e: any) {
      toast.error(`Create failed: ${e?.message ?? String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open onClose={onClose} title="New Promoted Listings campaign" size="md">
      <ModalBody>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Campaign name
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='e.g. "Spring 2026 — Italy boost"'
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Marketplace
            </label>
            <select
              value={marketplace}
              onChange={(e) => setMarketplace(e.target.value)}
              className="w-full h-9 px-2 text-md border border-slate-200 rounded"
            >
              {EBAY_MARKETPLACES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-1">
              Funding strategy
            </label>
            <div className="space-y-1.5 text-sm text-slate-700">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="funding"
                  value="STANDARD"
                  checked={fundingStrategy === 'STANDARD'}
                  onChange={() => setFundingStrategy('STANDARD')}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Standard (CPM)</span> — pay a percentage of
                  the sale price when an item sells through the campaign.
                </span>
              </label>
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="radio"
                  name="funding"
                  value="ADVANCED"
                  checked={fundingStrategy === 'ADVANCED'}
                  onChange={() => setFundingStrategy('ADVANCED')}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Advanced (CPC)</span> — pay per click with
                  a daily budget cap.
                </span>
              </label>
            </div>
          </div>
          {fundingStrategy === 'STANDARD' ? (
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Bid percentage
              </label>
              <Input
                type="number"
                step="0.10"
                min="0.10"
                max="100"
                value={bidPercentage}
                onChange={(e) => setBidPercentage(e.target.value)}
                placeholder="e.g. 5.00"
              />
              <div className="text-xs text-slate-500 mt-1">
                eBay charges this % of the final sale price for items sold via the campaign.
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  Daily budget
                </label>
                <Input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={dailyBudget}
                  onChange={(e) => setDailyBudget(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 mb-1">
                  Currency
                </label>
                <select
                  value={budgetCurrency}
                  onChange={(e) => setBudgetCurrency(e.target.value)}
                  className="h-9 px-2 text-md border border-slate-200 rounded"
                >
                  <option value="EUR">EUR</option>
                  <option value="GBP">GBP</option>
                  <option value="USD">USD</option>
                </select>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                Start date
              </label>
              <Input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-1">
                End date <span className="text-slate-400 font-normal">(optional)</span>
              </label>
              <Input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>
        </div>
      </ModalBody>
      <ModalFooter>
        <button
          onClick={onClose}
          disabled={busy}
          className="h-8 px-3 text-base text-slate-700 border border-slate-200 rounded hover:bg-slate-50"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={busy || !name.trim()}
          className="h-8 px-3 text-base bg-blue-600 text-white rounded hover:bg-blue-700 inline-flex items-center gap-1.5 disabled:opacity-50"
        >
          {busy ? 'Creating…' : 'Create campaign'}
        </button>
      </ModalFooter>
    </Modal>
  )
}
