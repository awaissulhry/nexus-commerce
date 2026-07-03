'use client'

/**
 * ER3.3 (delta 8) — Alerts with type-aware link-through: campaign-scoped
 * anomalies open the campaign, drift opens the hub's Drift tab, account-grain
 * spikes open the Ad Manager. Severity dot + type pill unchanged from v1.
 */
import Link from 'next/link'
import type { AnomalyRow } from '../_lib'

const targetFor = (a: AnomalyRow): string | null => {
  if (a.campaignId) return `/marketing/ads/ebay/campaigns/${a.campaignId}`
  if (a.type === 'nexus_ebay_drift') return '/marketing/ads/ebay/automation'
  if (a.type === 'fee_spike' || a.type === 'ctr_collapse') return '/marketing/ads/ebay/campaigns'
  return null
}

export function AlertsCard({ anomalies }: { anomalies: AnomalyRow[] }) {
  return (
    <div className="dash-card">
      <div className="dash-card-h"><span>Alerts</span></div>
      {anomalies.length === 0 ? (
        <div className="dash-empty">No anomalies — fee spikes, CTR collapses and external campaign changes appear here.</div>
      ) : (
        <div className="dash-alerts">
          {anomalies.map((a, i) => {
            const href = targetFor(a)
            const body = (
              <>
                <span className={`dash-sev--${a.severity === 'CRITICAL' ? 'high' : 'medium'}`} />
                <span className={`dash-atype--${a.type}`}>{a.type.replace(/_/g, ' ')}</span>
                <span className="dash-amsg">{a.message}</span>
                {href && <span className="eb-alert-go" aria-hidden="true">›</span>}
              </>
            )
            return href
              ? <Link key={i} className="dash-alert eb-alert-link" href={href}>{body}</Link>
              : <div key={i} className="dash-alert">{body}</div>
          })}
        </div>
      )}
    </div>
  )
}
