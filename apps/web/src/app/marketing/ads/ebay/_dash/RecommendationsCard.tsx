'use client'

/**
 * ER3.3 (delta 2) — the Recommendations panel (Teika adopt + Seller Hub
 * adapt): each row shows a live count, ITS ELIGIBILITY CRITERIA in one
 * sentence, sample entities, and a prefilled CTA. Zero-count rows hide;
 * nothing is padded.
 */
import Link from 'next/link'
import type { RecommendationRow } from '../_lib'

export function RecommendationsCard({ recs }: { recs: RecommendationRow[] | null }) {
  const visible = (recs ?? []).filter((r) => r.count > 0)
  return (
    <div className="dash-card">
      <div className="dash-card-h"><span>Recommendations</span></div>
      {recs == null ? (
        <div className="dash-empty">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="dash-empty">Nothing to recommend — matching, costs, coverage and margins look clean.</div>
      ) : (
        <div className="eb-recs">
          {visible.map((r) => (
            <div key={r.type} className="eb-rec">
              <span className="eb-rec-count">{r.count}</span>
              <div className="eb-rec-body">
                <b>{r.title}</b>
                <p className="eb-rec-criteria">{r.criteria}</p>
                {r.samples.length > 0 && <p className="eb-rec-samples">e.g. {r.samples.join(' · ')}</p>}
              </div>
              <Link className="h10-am-btn sm" href={r.cta.href}>{r.cta.label}</Link>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
