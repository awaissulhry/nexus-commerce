'use client'

/**
 * ACR.1.4 — Activity: what automation actually did, and why.
 *
 * The question this whole programme started from was "why did this bid move", and until now it
 * had no surface. The DATA has existed since ADX A2/G6 — `AdvertisingActionLog.evidence` carries
 * the metric, what was observed, the threshold it was measured against, the window and the sample
 * size — but it was written by one path and read by nothing.
 *
 * Deliberately NOT a second change log. `/marketing/ads/changelog` already renders the full
 * account feed with undo, filters and CSV export, and rebuilding that here would be two surfaces
 * over one endpoint drifting apart. This is the automation-scoped slice an operator wants when
 * they are standing in the Control Room — what did the machine do while I was away — with a
 * quiet link out to the full log for everything else.
 *
 * Two facts are kept apart on purpose, because they are genuinely different: what we INTENDED
 * (the field change) and whether Amazon TOOK it (delivery). Collapsing them is how a gated write
 * came to read as a success earlier today.
 */

import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface Change {
  id: string
  at: string
  actor: string | null
  source: string
  origin: { kind: string; id: string | null; name: string | null }
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  evidence: Record<string, unknown> | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
}

const when = (iso: string) => {
  const d = new Date(iso)
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ago` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The numbers behind the prose. Absent on most writers still — that is normal, not an error. */
function Evidence({ e }: { e: Record<string, unknown> }) {
  const metric = e.metric as string | undefined
  const observed = e.observed as number | null | undefined
  const threshold = e.threshold as number | null | undefined
  const sample = e.sampleSize as number | null | undefined
  const unit = (e.sampleUnit as string | undefined) ?? 'rows'
  const target = e.targetKey as string | undefined
  if (!metric && observed == null && !target) return null
  return (
    <span className="acr-ev">
      {target && <span className="acr-ev-k">{target}</span>}
      {metric && (
        <span>
          {metric}
          {observed != null && <> <strong>{observed}</strong></>}
          {threshold != null && <> vs {threshold}</>}
        </span>
      )}
      {/* Thin evidence is flagged rather than hidden: a decision resting on 3 days of data
          must not look identical to one resting on 56. */}
      {sample != null && (
        <span className={sample < 7 && unit === 'days' ? 'thin' : undefined}>
          {sample} {unit}{sample < 7 && unit === 'days' ? ' — thin' : ''}
        </span>
      )}
    </span>
  )
}

export function ActivityTab() {
  const [rows, setRows] = useState<Change[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes?source=automation&limit=60`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`changes: ${r.status}`)
      const j = await r.json()
      setRows(Array.isArray(j?.items) ? (j.items as Change[]) : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRows([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  if (err) return <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (rows === null) return <div className="acr-empty">Loading…</div>

  return (
    <div className="acr-activity">
      <div className="acr-sec-head">
        <h2>What automation did</h2>
        <span className="acr-sec-count">
          {rows.length ? `last ${rows.length} automated changes` : ''}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="acr-empty">
          No automated changes recorded in this window. That is a real state, not an error —
          every engine may simply be off or holding.
        </div>
      ) : (
        <ul className="acr-changes">
          {rows.map((c) => (
            <li key={c.id} className="acr-change">
              <div className="acr-change-head">
                <span className="acr-change-what">
                  <strong>{c.field}</strong>
                  {c.oldValue != null && c.newValue != null && (
                    <span className="acr-delta">{c.oldValue} → {c.newValue}</span>
                  )}
                </span>
                {/* Intent and delivery are separate facts. A change we made and a change
                    Amazon took are not the same thing. */}
                {c.delivery && (
                  <span className={`acr-deliv ${c.delivery.state.toLowerCase()}`} title={c.delivery.lastError ?? undefined}>
                    {c.delivery.state}
                  </span>
                )}
                <span className="acr-change-when">{when(c.at)}</span>
              </div>
              <div className="acr-change-sub">
                {c.origin.name ?? c.actor ?? 'system'}
                {c.campaign?.name ? ` · ${c.campaign.name}` : c.entity.name ? ` · ${c.entity.name}` : ''}
              </div>
              {c.reason && <div className="acr-change-why">{c.reason}</div>}
              {c.evidence && <Evidence e={c.evidence} />}
            </li>
          ))}
        </ul>
      )}

      <p className="acr-foot">
        This is the automation-scoped slice.{' '}
        <a href="/marketing/ads/changelog" target="_blank" rel="noopener noreferrer" className="acr-link">
          The full account change log <ExternalLink size={11} />
        </a>{' '}
        carries operator changes, filters, undo and CSV export.
      </p>
    </div>
  )
}
