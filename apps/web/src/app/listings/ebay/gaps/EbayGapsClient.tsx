'use client'

import { useState, useTransition, useCallback } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  PackagePlus,
  RefreshCw,
  Calendar,
  AlertTriangle,
  XCircle,
  Image,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────

interface GapProduct {
  id: string
  sku: string
  name: string
  productType: string | null
  brand: string | null
  variationTheme: string | null
  variationCount: number
  hasImages: boolean
  hasDescription: boolean
}

interface GapSummary {
  marketplace: string
  totalActive: number
  withEbayListing: number
  gap: number
  products: GapProduct[]
}

interface ScheduleProgress {
  marketplace: string
  gap: number
  withEbayListing: number
  totalActive: number
  scheduled: { pending: number; fired: number; failed: number; cancelled: number }
}

interface Props {
  marketplace: string
  initialGap: GapSummary | null
  initialProgress: ScheduleProgress | null
}

const MARKETPLACE_OPTIONS = ['IT', 'DE', 'FR', 'ES']

const TYPE_LABELS: Record<string, string> = {
  MOTORCYCLE_JACKET: 'Jacket',
  MOTORCYCLE_GLOVES: 'Gloves',
  MOTORCYCLE_BOOTS: 'Boots',
  MOTORCYCLE_HELMET: 'Helmet',
  MOTORCYCLE_PANTS: 'Pants',
  MOTORCYCLE_SUIT: 'Suit',
  MOTORCYCLE_VEST: 'Vest',
  MOTORCYCLE_ARMOR: 'Armor',
  MOTORCYCLE_ACCESSORY: 'Accessory',
}

function readinessBadge(p: GapProduct) {
  if (p.hasImages && p.hasDescription && p.productType) {
    return <span className="px-1.5 py-0.5 bg-green-100 text-green-700 rounded text-xs font-medium">Ready</span>
  }
  if (p.hasImages || p.hasDescription) {
    return <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded text-xs font-medium">Partial</span>
  }
  return <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-xs font-medium">No content</span>
}

export default function EbayGapsClient({ marketplace: initMarketplace, initialGap, initialProgress }: Props) {
  const backend = getBackendUrl()
  const [marketplace, setMarketplace] = useState(initMarketplace)
  const [gap, setGap] = useState<GapSummary | null>(initialGap)
  const [progress, setProgress] = useState<ScheduleProgress | null>(initialProgress)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dailyLimit, setDailyLimit] = useState(50)
  const [startDate, setStartDate] = useState('')
  const [scheduleMsg, setScheduleMsg] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const refreshData = useCallback(async (mp: string) => {
    const [gr, pr] = await Promise.all([
      fetch(`${backend}/api/ebay/phase3/gap?marketplace=${mp}`, { cache: 'no-store' }).catch(() => null),
      fetch(`${backend}/api/ebay/phase3/progress?marketplace=${mp}`, { cache: 'no-store' }).catch(() => null),
    ])
    if (gr?.ok) setGap(await gr.json().catch(() => null))
    if (pr?.ok) setProgress(await pr.json().catch(() => null))
    setSelected(new Set())
  }, [backend])

  const handleMarketplace = (mp: string) => {
    setMarketplace(mp)
    startTransition(() => { refreshData(mp) })
  }

  const handleSelectAll = () => {
    if (selected.size === (gap?.products.length ?? 0)) {
      setSelected(new Set())
    } else {
      setSelected(new Set(gap?.products.map(p => p.id) ?? []))
    }
  }

  const handleSchedule = async (all: boolean) => {
    setScheduleMsg('Scheduling…')
    const body: any = {
      marketplace,
      dailyLimit,
      startDate: startDate ? new Date(startDate).toISOString() : undefined,
    }
    if (all) {
      body.scheduleAll = true
    } else {
      body.productIds = [...selected]
    }

    const res = await fetch(`${backend}/api/ebay/phase3/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)

    if (res?.ok) {
      const data = await res.json()
      setScheduleMsg(`✓ Scheduled ${data.totalScheduled} listings — ${data.dailyLimit}/day from ${new Date(data.startDate).toLocaleDateString('it-IT')} to ${new Date(data.endDate).toLocaleDateString('it-IT')}`)
      await refreshData(marketplace)
    } else {
      const err = await res?.json().catch(() => null)
      setScheduleMsg(`Error: ${err?.error ?? 'Unknown failure'}`)
    }
  }

  const products = gap?.products ?? []
  const readyCount = products.filter(p => p.hasImages && p.hasDescription && p.productType).length
  const partialCount = products.filter(p => (p.hasImages || p.hasDescription) && !(p.hasImages && p.hasDescription)).length

  // Type breakdown
  const byType = products.reduce<Record<string, number>>((acc, p) => {
    const t = p.productType ?? 'Unknown'
    acc[t] = (acc[t] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">eBay Listing Gaps</h1>
            <p className="text-sm text-gray-500 mt-0.5">Phase 3 — products active in Nexus but missing from eBay</p>
          </div>
          <button
            onClick={() => startTransition(() => refreshData(marketplace))}
            disabled={isPending}
            className="flex items-center gap-2 px-3 py-1.5 border rounded text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isPending ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-4 max-w-screen-xl mx-auto">
        {/* Marketplace selector */}
        <div className="flex gap-2 mb-5">
          {MARKETPLACE_OPTIONS.map(mp => (
            <button
              key={mp}
              onClick={() => handleMarketplace(mp)}
              className={`px-3 py-1.5 rounded border text-sm font-medium transition-colors ${marketplace === mp ? 'bg-gray-900 text-white border-gray-900' : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
            >
              {mp}
            </button>
          ))}
        </div>

        {/* Stats strip */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          <div className="bg-white border rounded-lg px-4 py-3">
            <div className="text-2xl font-semibold text-gray-900">{gap?.gap ?? '—'}</div>
            <div className="text-xs text-gray-500">Missing eBay listings</div>
          </div>
          <div className="bg-white border rounded-lg px-4 py-3">
            <div className="text-2xl font-semibold text-green-700">{readyCount}</div>
            <div className="text-xs text-gray-500">Ready (images + desc)</div>
          </div>
          <div className="bg-white border rounded-lg px-4 py-3">
            <div className="text-2xl font-semibold text-amber-700">{partialCount}</div>
            <div className="text-xs text-gray-500">Partial content</div>
          </div>
          <div className="bg-white border rounded-lg px-4 py-3">
            <div className="text-2xl font-semibold text-blue-700">{progress?.scheduled.pending ?? '—'}</div>
            <div className="text-xs text-gray-500">Scheduled (pending)</div>
          </div>
        </div>

        {/* Type breakdown */}
        {Object.keys(byType).length > 0 && (
          <div className="flex gap-2 flex-wrap mb-5">
            {Object.entries(byType).sort((a,b) => b[1]-a[1]).map(([t, n]) => (
              <span key={t} className="px-3 py-1 bg-white border rounded-full text-xs text-gray-600">
                {TYPE_LABELS[t] ?? t}: <strong>{n}</strong>
              </span>
            ))}
          </div>
        )}

        {/* Schedule controls */}
        {(gap?.gap ?? 0) > 0 && (
          <div className="bg-white border rounded-lg p-4 mb-5">
            <h3 className="font-medium text-gray-800 mb-3 flex items-center gap-2">
              <Calendar className="w-4 h-4" /> Schedule bulk listing creation
            </h3>
            <div className="flex gap-4 items-end flex-wrap">
              <div>
                <label className="text-xs text-gray-500 block mb-1">Daily limit</label>
                <select
                  value={dailyLimit}
                  onChange={e => setDailyLimit(Number(e.target.value))}
                  className="border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                >
                  <option value={25}>25/day — conservative</option>
                  <option value={50}>50/day — recommended</option>
                  <option value={100}>100/day — week 2+</option>
                  <option value={200}>200/day — month 2+</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-gray-500 block mb-1">Start date (optional)</label>
                <input
                  type="date"
                  value={startDate}
                  onChange={e => setStartDate(e.target.value)}
                  min={new Date().toISOString().slice(0, 10)}
                  className="border rounded px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
              <div className="flex gap-2">
                {selected.size > 0 && (
                  <button
                    onClick={() => handleSchedule(false)}
                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
                  >
                    <PackagePlus className="w-4 h-4" />
                    Schedule {selected.size} selected
                  </button>
                )}
                <button
                  onClick={() => handleSchedule(true)}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white rounded text-sm font-medium hover:bg-gray-800"
                >
                  <PackagePlus className="w-4 h-4" />
                  Schedule all {gap?.gap}
                </button>
              </div>
            </div>
            {scheduleMsg && (
              <div className={`mt-3 px-3 py-2 rounded text-sm ${scheduleMsg.startsWith('✓') ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                {scheduleMsg}
              </div>
            )}
            <p className="mt-3 text-xs text-gray-500">
              ⚠ Scheduling creates eBay listing wizards. The eBay publish gate must be ON and EBAY_PUBLISH_MODE=live before listings actually go live. You can review/cancel scheduled publishes on the listing wizard pages.
            </p>
          </div>
        )}

        {/* Product table */}
        <div className="bg-white border rounded-lg overflow-hidden">
          {products.length === 0 ? (
            <div className="py-16 text-center text-gray-400">
              {gap === null ? 'Loading…' : `No gap products for eBay ${marketplace}. All active products have eBay listings!`}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={selected.size === products.length && products.length > 0}
                      onChange={handleSelectAll}
                      className="rounded"
                    />
                  </th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-44">SKU</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Name</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-32">Type</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-24">Variations</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-20">Images</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 w-24">Readiness</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {products.map(p => (
                  <tr key={p.id} className={`hover:bg-gray-50 ${selected.has(p.id) ? 'bg-blue-50' : ''}`}>
                    <td className="px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={selected.has(p.id)}
                        onChange={e => {
                          const next = new Set(selected)
                          if (e.target.checked) next.add(p.id); else next.delete(p.id)
                          setSelected(next)
                        }}
                        className="rounded"
                      />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-600 truncate max-w-[11rem]">{p.sku}</td>
                    <td className="px-4 py-2.5 text-gray-700">
                      <div className="text-xs line-clamp-2">{p.name}</div>
                      {p.variationTheme && <div className="text-gray-400 text-xs">{p.variationTheme}</div>}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600">{TYPE_LABELS[p.productType ?? ''] ?? p.productType ?? '—'}</td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 text-center">{p.variationCount || '—'}</td>
                    <td className="px-4 py-2.5">
                      {p.hasImages
                        ? <Image className="w-4 h-4 text-green-600 mx-auto" />
                        : <XCircle className="w-4 h-4 text-gray-300 mx-auto" />}
                    </td>
                    <td className="px-4 py-2.5">{readinessBadge(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Trust & Safety warning */}
        {(gap?.gap ?? 0) > 100 && (
          <div className="mt-4 bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm text-amber-800">
            <div className="flex gap-2 items-start">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div>
                <strong>Trust & Safety:</strong> Don&apos;t create {gap!.gap} listings overnight.
                eBay flags new bulk listings from accounts. Use the 50/day default for weeks 1-2,
                increase to 100/day week 3+, and 200/day month 2+. Monitor for any holds at
                <em> Seller Hub → Performance → Seller Standards</em>.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
