'use client'

import { useState, useEffect } from 'react'
import { ChevronRight, Check, X, Layers } from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'
import { cn } from '@/lib/utils'

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

function GroupSkeleton() {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 animate-pulse">
      <div className="flex items-center gap-4">
        <div className="w-5 h-5 bg-slate-200 rounded" />
        <div className="flex-1 space-y-2">
          <div className="h-3 bg-slate-200 rounded w-3/4" />
          <div className="h-2 bg-slate-200 rounded w-1/2" />
        </div>
        <div className="w-24 h-6 bg-slate-200 rounded" />
        <div className="w-16 h-7 bg-slate-200 rounded" />
      </div>
    </div>
  )
}

export default function PIMReviewPage() {
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<DetectedGroup[]>([])
  const [standalone, setStandalone] = useState<StandaloneProduct[]>([])
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null)
  const [approvedGroups, setApprovedGroups] = useState<Set<string>>(new Set())
  const [rejectedGroups, setRejectedGroups] = useState<Set<string>>(new Set())
  const [applying, setApplying] = useState(false)
  const [statusMsg, setStatusMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(
    null
  )

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
    setStatusMsg(null)
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
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      const result = await res.json()
      setStatusMsg({
        kind: 'success',
        text: `Created ${result.mastersCreated} master${
          result.mastersCreated === 1 ? '' : 's'
        }, linked ${result.childrenLinked} children${
          result.errors?.length ? ` (${result.errors.length} errors — see console)` : ''
        }`,
      })
      if (result.errors?.length) console.warn('[PIM] apply errors', result.errors)
      setApprovedGroups(new Set())
      setRejectedGroups(new Set())
      fetchDetection()
    } catch (e) {
      setStatusMsg({ kind: 'error', text: `Apply failed: ${(e as Error).message}` })
    } finally {
      setApplying(false)
    }
  }

  function toggleApproved(id: string) {
    setApprovedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setRejectedGroups((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function toggleRejected(id: string) {
    setRejectedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setApprovedGroups((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  function confidenceVariant(conf: number): 'success' | 'warning' | 'danger' {
    if (conf >= 80) return 'success'
    if (conf >= 60) return 'warning'
    return 'danger'
  }

  const totalMembers = groups.reduce((sum, g) => sum + g.members.length, 0)
  const pendingCount = groups.length - approvedGroups.size - rejectedGroups.size

  return (
    <div className="space-y-5">
      <PageHeader
        title="PIM Review"
        description={
          loading
            ? 'Detecting variation groups…'
            : `Detected ${groups.length} group${
                groups.length === 1 ? '' : 's'
              } across ${totalMembers} product${totalMembers === 1 ? '' : 's'}`
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={loading || groups.length === 0}
              onClick={() =>
                setApprovedGroups(
                  new Set(groups.filter((g) => g.confidence >= 80).map((g) => g.id))
                )
              }
            >
              Auto-approve 80%+
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={applying}
              disabled={approvedGroups.size === 0}
              onClick={handleApplyApproved}
            >
              {`Apply ${approvedGroups.size || ''} Approved`.trim()}
            </Button>
          </>
        }
      />

      {/* Approval counters */}
      {!loading && groups.length > 0 && (
        <Card>
          <div className="flex items-center gap-6 text-[13px] -my-1">
            <div className="flex items-center gap-2">
              <Badge variant="success" size="md">
                {approvedGroups.size}
              </Badge>
              <span className="text-slate-600">approved</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="danger" size="md">
                {rejectedGroups.size}
              </Badge>
              <span className="text-slate-600">rejected</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="default" size="md">
                {pendingCount}
              </Badge>
              <span className="text-slate-600">pending</span>
            </div>
            {statusMsg && (
              <div
                className={cn(
                  'ml-auto text-[12px] px-3 py-1 rounded border',
                  statusMsg.kind === 'success'
                    ? 'bg-green-50 border-green-200 text-green-700'
                    : 'bg-red-50 border-red-200 text-red-700'
                )}
              >
                {statusMsg.text}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Groups */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <GroupSkeleton key={i} />
          ))}
        </div>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={Layers}
          title="No variation groups detected"
          description="Either every product is already grouped, or there aren't enough similar items to detect a pattern. Re-run detection after importing more products."
          action={{ label: 'View Catalog', href: '/inventory' }}
        />
      ) : (
        <div className="space-y-3">
          {groups.map((group) => {
            const isApproved = approvedGroups.has(group.id)
            const isRejected = rejectedGroups.has(group.id)
            const isExpanded = expandedGroup === group.id
            return (
              <div
                key={group.id}
                className={cn(
                  'bg-white border-2 rounded-lg overflow-hidden transition-colors',
                  isApproved && 'border-green-400',
                  isRejected && 'border-red-300 opacity-50',
                  !isApproved && !isRejected && 'border-slate-200'
                )}
              >
                <div className="p-4 flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setExpandedGroup(isExpanded ? null : group.id)}
                    className="p-1 rounded hover:bg-slate-100 text-slate-500 hover:text-slate-900 transition-colors"
                    aria-label={isExpanded ? 'Collapse' : 'Expand'}
                  >
                    <ChevronRight
                      className={cn(
                        'w-4 h-4 transition-transform',
                        isExpanded && 'rotate-90'
                      )}
                    />
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-slate-900 truncate">
                      {group.baseName}
                    </div>
                    <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
                      <span className="font-mono bg-slate-100 px-1.5 py-0.5 rounded text-slate-700">
                        {group.suggestedMasterSku}
                      </span>
                      <span>·</span>
                      <span>
                        {group.members.length} variant
                        {group.members.length === 1 ? '' : 's'}
                      </span>
                      <span>·</span>
                      <span>{group.variationAxes.join(' / ') || '—'}</span>
                    </div>
                  </div>
                  <Badge variant={confidenceVariant(group.confidence)} size="md">
                    {group.confidence}% confidence
                  </Badge>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => toggleApproved(group.id)}
                      className={cn(
                        'p-1.5 rounded-md transition-colors',
                        isApproved
                          ? 'bg-green-500 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-green-100'
                      )}
                      title="Approve"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleRejected(group.id)}
                      className={cn(
                        'p-1.5 rounded-md transition-colors',
                        isRejected
                          ? 'bg-red-500 text-white'
                          : 'bg-slate-100 text-slate-600 hover:bg-red-100'
                      )}
                      title="Reject"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-slate-200 bg-slate-50 p-4">
                    <div className="text-[11px] font-semibold text-slate-700 uppercase tracking-wide mb-2">
                      {group.members.length} variation
                      {group.members.length === 1 ? '' : 's'}
                    </div>
                    <ul className="space-y-1.5">
                      {group.members.map((m) => (
                        <li
                          key={m.productId}
                          className="bg-white border border-slate-200 rounded-md p-2.5 flex items-center justify-between gap-3"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] font-medium text-slate-900 truncate font-mono">
                              {m.sku}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">{m.name}</div>
                            {m.asin && (
                              <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                                ASIN: {m.asin}
                              </div>
                            )}
                          </div>
                          <div className="flex gap-1 flex-wrap justify-end max-w-[60%]">
                            {Object.entries(m.detectedAttributes).map(([k, v]) => (
                              <Badge key={k} variant="info" size="sm">
                                <span className="text-blue-600">{k}:</span>
                                <span className="ml-1">{v}</span>
                              </Badge>
                            ))}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Standalone */}
      {!loading && standalone.length > 0 && (
        <Card
          title={`Standalone Products (${standalone.length})`}
          description="These products don't appear to be variations. They'll remain as standalone master products."
        >
          <ul className="space-y-1 -my-0.5">
            {standalone.slice(0, 10).map((p) => (
              <li
                key={p.id}
                className="text-[12px] text-slate-600 flex items-baseline gap-2"
              >
                <span className="font-mono text-slate-700 flex-shrink-0">{p.sku}</span>
                <span className="text-slate-400">·</span>
                <span className="truncate">{p.name}</span>
              </li>
            ))}
            {standalone.length > 10 && (
              <li className="text-[11px] text-slate-400 mt-2">
                …and {standalone.length - 10} more
              </li>
            )}
          </ul>
        </Card>
      )}
    </div>
  )
}
