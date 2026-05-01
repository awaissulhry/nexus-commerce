'use client'

import { useState, useEffect } from 'react'
import { ChevronRight, Check, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface DetectedGroup {
  id: string
  baseName: string
  suggestedMasterSku: string
  confidence: number
  variationAxes: string[]
  members: Array<{
    productId: string
    sku: string
    name: string
    asin: string | null
    detectedAttributes: Record<string, string>
  }>
}

interface StandaloneProduct {
  id: string
  sku: string
  name: string
}

export default function PIMReviewPage() {
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<DetectedGroup[]>([])
  const [standalone, setStandalone] = useState<StandaloneProduct[]>([])
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [approvedGroups, setApprovedGroups] = useState<Set<string>>(new Set())
  const [rejectedGroups, setRejectedGroups] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    fetchDetection()
  }, [])

  async function fetchDetection() {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/amazon/pim/detect-groups`, {
        cache: 'no-store',
      })
      const data = await res.json()
      setGroups(data.groups ?? [])
      setStandalone(data.standalone ?? [])
    } catch (e) {
      console.error('[PIM] detect-groups failed', e)
    } finally {
      setLoading(false)
    }
  }

  async function handleApplyApproved() {
    setApplying(true)
    try {
      const toApply = groups
        .filter((g) => approvedGroups.has(g.id))
        .map((g) => ({
          masterSku: g.suggestedMasterSku,
          masterName: g.baseName,
          variationAxes: g.variationAxes,
          children: g.members.map((m) => ({
            productId: m.productId,
            attributes: m.detectedAttributes,
          })),
        }))
      const res = await fetch(`${getBackendUrl()}/api/amazon/pim/apply-groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groups: toApply }),
      })
      const result = await res.json()
      alert(
        `Applied! Created ${result.mastersCreated} masters, linked ${result.childrenLinked} children` +
          (result.errors?.length ? `\n\nErrors:\n${result.errors.join('\n')}` : '')
      )
      setApprovedGroups(new Set())
      setRejectedGroups(new Set())
      fetchDetection()
    } catch (e) {
      console.error('[PIM] apply failed', e)
      alert('Apply failed; see console.')
    } finally {
      setApplying(false)
    }
  }

  function getConfidenceColor(conf: number) {
    if (conf >= 80) return 'bg-green-100 text-green-700 border-green-300'
    if (conf >= 60) return 'bg-yellow-100 text-yellow-700 border-yellow-300'
    return 'bg-red-100 text-red-700 border-red-300'
  }

  if (loading) {
    return <div className="p-8 text-center text-slate-500">Detecting variation groups…</div>
  }

  const pendingCount = groups.length - approvedGroups.size - rejectedGroups.size

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">Master Catalog — Review Detected Groups</h1>
        <p className="text-slate-600">
          Detected {groups.length} potential variation groups across{' '}
          {groups.reduce((sum, g) => sum + g.members.length, 0)} products. Review and approve to
          create master products in your catalog.
        </p>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-4 mb-6 flex items-center justify-between">
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-600">
            <span className="font-bold text-green-600">{approvedGroups.size}</span> approved
          </span>
          <span className="text-slate-600">
            <span className="font-bold text-red-600">{rejectedGroups.size}</span> rejected
          </span>
          <span className="text-slate-600">
            <span className="font-bold text-slate-900">{pendingCount}</span> pending
          </span>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() =>
              setApprovedGroups(new Set(groups.filter((g) => g.confidence >= 80).map((g) => g.id)))
            }
            className="px-3 py-1.5 text-sm bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 border border-blue-200"
          >
            Auto-approve high confidence (80%+)
          </button>
          <button
            onClick={handleApplyApproved}
            disabled={approvedGroups.size === 0 || applying}
            className="px-4 py-1.5 text-sm bg-green-600 text-white rounded-md hover:bg-green-700 disabled:opacity-50"
          >
            {applying ? 'Applying…' : `Apply ${approvedGroups.size} Approved Groups`}
          </button>
        </div>
      </div>

      <div className="space-y-3">
        {groups.map((group) => (
          <div
            key={group.id}
            className={`bg-white border-2 rounded-lg overflow-hidden ${
              approvedGroups.has(group.id)
                ? 'border-green-400'
                : rejectedGroups.has(group.id)
                ? 'border-red-400 opacity-50'
                : 'border-slate-200'
            }`}
          >
            <div className="p-4 flex items-center gap-4">
              <button
                onClick={() => setExpandedGroup(expandedGroup === group.id ? null : group.id)}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <ChevronRight
                  className={`w-5 h-5 transition-transform ${
                    expandedGroup === group.id ? 'rotate-90' : ''
                  }`}
                />
              </button>

              <div className="flex-1 min-w-0">
                <div className="font-medium text-slate-900 truncate">{group.baseName}</div>
                <div className="text-sm text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
                  <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">
                    {group.suggestedMasterSku}
                  </span>
                  <span>{group.members.length} variants</span>
                  <span>•</span>
                  <span>Axes: {group.variationAxes.join(' / ') || '—'}</span>
                </div>
              </div>

              <div
                className={`text-xs px-2 py-1 rounded-md border whitespace-nowrap ${getConfidenceColor(
                  group.confidence
                )}`}
              >
                {group.confidence}% confidence
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setApprovedGroups((prev) => {
                      const next = new Set(prev)
                      if (next.has(group.id)) next.delete(group.id)
                      else next.add(group.id)
                      return next
                    })
                    setRejectedGroups((prev) => {
                      const next = new Set(prev)
                      next.delete(group.id)
                      return next
                    })
                  }}
                  className={`p-2 rounded-md ${
                    approvedGroups.has(group.id)
                      ? 'bg-green-500 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-green-100'
                  }`}
                  title="Approve"
                >
                  <Check className="w-4 h-4" />
                </button>
                <button
                  onClick={() => {
                    setRejectedGroups((prev) => {
                      const next = new Set(prev)
                      if (next.has(group.id)) next.delete(group.id)
                      else next.add(group.id)
                      return next
                    })
                    setApprovedGroups((prev) => {
                      const next = new Set(prev)
                      next.delete(group.id)
                      return next
                    })
                  }}
                  className={`p-2 rounded-md ${
                    rejectedGroups.has(group.id)
                      ? 'bg-red-500 text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-red-100'
                  }`}
                  title="Reject"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {expandedGroup === group.id && (
              <div className="border-t border-slate-200 bg-slate-50 p-4">
                <div className="text-xs font-medium text-slate-700 mb-2">
                  {group.members.length} variations:
                </div>
                <div className="grid gap-2">
                  {group.members.map((m) => (
                    <div
                      key={m.productId}
                      className="bg-white border border-slate-200 rounded p-3 flex items-center justify-between gap-3"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{m.sku}</div>
                        <div className="text-xs text-slate-500 truncate">{m.name}</div>
                        {m.asin && (
                          <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                            ASIN: {m.asin}
                          </div>
                        )}
                      </div>
                      <div className="flex gap-1.5 flex-wrap justify-end">
                        {Object.entries(m.detectedAttributes).map(([k, v]) => (
                          <span
                            key={k}
                            className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200 px-1.5 py-0.5 rounded whitespace-nowrap"
                          >
                            <strong>{k}:</strong> {v}
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {standalone.length > 0 && (
        <div className="mt-8">
          <h2 className="text-lg font-semibold mb-3">
            Standalone Products ({standalone.length})
          </h2>
          <p className="text-sm text-slate-600 mb-4">
            These products don't appear to be variations. They'll remain as standalone master
            products.
          </p>
          <div className="bg-white border border-slate-200 rounded-lg p-4">
            <div className="text-xs text-slate-500 space-y-1">
              {standalone.slice(0, 10).map((p) => (
                <div key={p.id}>
                  <span className="font-mono">{p.sku}</span> — {p.name}
                </div>
              ))}
              {standalone.length > 10 && (
                <div className="text-slate-400 mt-2">
                  … and {standalone.length - 10} more
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
