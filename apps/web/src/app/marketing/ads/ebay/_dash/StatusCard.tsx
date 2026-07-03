'use client'

/**
 * ER3.3 (delta 4) — the Status card decomposed into three labelled groups:
 * Campaigns (status pills → Ad Manager) · Coverage (bar) · Data (attribution
 * + freshness + the 72h note). Replaces the v1 raw key/value dump.
 */
import Link from 'next/link'
import { StatusPill } from '../../_shared/StatusPill'
import { ebayStatusPill } from '../_lib/status'
import type { SummaryPayload } from '../_lib'

export function StatusCard({ s }: { s: SummaryPayload | null }) {
  const cov = s?.coverage
  return (
    <div className="dash-card">
      <div className="dash-card-h"><span>Status</span></div>
      {s == null ? (
        <div className="dash-empty">Loading…</div>
      ) : (
        <div className="eb-status-groups">
          <section>
            <h5>Campaigns</h5>
            <div className="eb-status-pills">
              {Object.entries(s.campaignCounts).map(([k, v]) => {
                const sp = ebayStatusPill(k)
                return (
                  <Link key={k} href="/marketing/ads/ebay/campaigns" className="eb-status-pill-link" title={`Open Ad Manager (${v} ${sp.label.toLowerCase()})`}>
                    <StatusPill label={`${sp.label} ${v}`} cls={sp.cls} />
                  </Link>
                )
              })}
            </div>
          </section>
          {cov && (
            <section>
              <h5 title="Live listings promoted in ≥1 active General campaign — the coverage guard proposes enrollment for the rest">Ad coverage</h5>
              <div className="eb-pace-bar" role="img" aria-label={`${cov.pct ?? 0}% of live listings promoted`}>
                <span className={`fill ${(cov.pct ?? 0) >= 90 ? '' : 'warn'}`} style={{ width: `${Math.min(100, cov.pct ?? 0)}%` }} />
              </div>
              <p className="eb-status-sub">{cov.pct != null ? `${cov.pct}%` : '—'} · {cov.promoted}/{cov.liveListings} live listings promoted</p>
            </section>
          )}
          <section>
            <h5>Data</h5>
            <p className="eb-status-sub">Attribution: any-click (30d) · fees reconcile ~72h</p>
            <p className="eb-status-sub">Facts as of {s.freshness.factsReportedAt ? new Date(s.freshness.factsReportedAt).toLocaleString('en-GB') : '—'}</p>
            <p className="eb-status-sub">Entities as of {s.freshness.entitySyncAt ? new Date(s.freshness.entitySyncAt).toLocaleString('en-GB') : '—'}</p>
          </section>
        </div>
      )}
    </div>
  )
}
