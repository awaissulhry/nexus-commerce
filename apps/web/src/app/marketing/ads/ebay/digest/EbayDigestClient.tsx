'use client'

/**
 * E5 — the weekly review. One page = the whole week: money, movers, what
 * autopilot did, what awaits approval (deep-link), anomalies, data health.
 * Data + renderer split: this renders EbayAdsDigest.payload; delivery
 * channels (email/WhatsApp) can plug into the same payload later.
 * E7 consistency pass: pure h10 idiom (no design-system imports) like every
 * other page in the ads console.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { getBackendUrl } from '@/lib/backend-url'
import '../ebay.css'
import { postEbayAds, eurC, pctP, intlN } from '../_lib'

interface DigestPayload {
  week: { start: string; end: string }
  totals: { adFeesCents: number; salesCents: number; clicks: number; impressions: number; soldQty: number; acosPct: number | null }
  prior: { adFeesCents: number; salesCents: number; soldQty: number }
  movers: Array<{ campaign: string; feesCents: number; salesCents: number; sold: number }>
  autopilotApplied: Array<{ kind: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string }; result?: { detail?: string } | null }>
  pendingProposals: Array<{ id: string; kind: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string } }>
  anomalies: Array<{ type: string; severity: string; message: string }>
  economics: Record<string, number>
  generatedAt: string
}

function EmptyNote({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ padding: '20px 8px', textAlign: 'center' }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: '#475467', margin: 0 }}>{title}</p>
      {description && <p style={{ fontSize: 12, color: '#8a93a1', margin: '4px 0 0' }}>{description}</p>}
    </div>
  )
}

export function EbayDigestClient() {
  const [digest, setDigest] = useState<{ id: string; weekStart: string; reviewedAt: string | null; payload: DigestPayload } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/ebay-ads/digest/latest`, { credentials: 'include' })
      const j = await r.json()
      setDigest(j.digest)
    } catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }, [])
  useEffect(() => { void reload() }, [reload])

  const generate = async () => {
    setBusy(true); setError(null)
    try { await postEbayAds('/digest/generate', {}); await reload() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const markReviewed = async () => {
    if (!digest) return
    setBusy(true)
    try { await postEbayAds(`/digest/${digest.id}/reviewed`, {}); await reload() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const p = digest?.payload
  const delta = (cur: number, prev: number) => (prev > 0 ? ` (${cur >= prev ? '+' : ''}${(((cur - prev) / prev) * 100).toFixed(0)}% vs prior wk)` : '')

  return (
    <div className="eb-page h10-am">
      <AdsPageHeader title="eBay Weekly Digest" subtitle="The one weekly review: money, movers, what autopilot did, what needs your decision." markets={['EBAY_IT']} market="EBAY_IT" onMarketChange={() => {}} />
      <div className="eb-controls">
        <button type="button" className="h10-am-btn" onClick={() => void generate()} disabled={busy}>{busy ? 'Generating…' : 'Generate now'}</button>
        {digest && !digest.reviewedAt && <button type="button" className="h10-am-btn primary" onClick={() => void markReviewed()} disabled={busy}>Mark week reviewed ✓</button>}
        {digest?.reviewedAt && <span className="eb-chip eb-chip--run">reviewed {new Date(digest.reviewedAt).toLocaleDateString('en-GB')}</span>}
      </div>
      {error && <div className="h10-am-latest" role="alert"><b>Digest error:</b> {error}</div>}
      {loading ? (
        <div className="eb-panel" aria-busy="true"><EmptyNote title="Loading digest…" /></div>
      ) : !p ? (
        <div className="eb-panel">
          <EmptyNote title="No digest yet" description="Digests generate every Monday morning (Rome) — or press Generate now." />
          <div style={{ textAlign: 'center', paddingBottom: 16 }}>
            <button type="button" className="h10-am-btn primary" onClick={() => void generate()} disabled={busy}>Generate now</button>
          </div>
        </div>
      ) : (
        <>
          <section className="eb-panel eb-panel--head">
            <header className="eb-panel-head"><h3>Week {p.week.start} → {p.week.end}</h3><span className="eb-panel-note">any-click attribution · generated {new Date(p.generatedAt).toLocaleString('en-GB')}</span></header>
            <div className="eb-headstats">
              <div><span className="k">Ad fees</span><span className="v">{eurC(p.totals.adFeesCents)}{delta(p.totals.adFeesCents, p.prior.adFeesCents)}</span></div>
              <div><span className="k">Ad sales</span><span className="v">{eurC(p.totals.salesCents)}{delta(p.totals.salesCents, p.prior.salesCents)}</span></div>
              <div><span className="k">eBay ACOS</span><span className="v">{pctP(p.totals.acosPct)}</span></div>
              <div><span className="k">Clicks</span><span className="v">{intlN(p.totals.clicks)}</span></div>
              <div><span className="k">Impressions</span><span className="v">{intlN(p.totals.impressions)}</span></div>
              <div><span className="k">Sold</span><span className="v">{intlN(p.totals.soldQty)}{delta(p.totals.soldQty, p.prior.soldQty)}</span></div>
            </div>
          </section>

          {p.anomalies.length > 0 && (
            <section className="eb-panel" style={{ borderColor: '#f0d9a8', background: '#fdf6e3' }}>
              <header className="eb-panel-head"><h3 style={{ color: '#7a5b00' }}>{p.anomalies.length} anomal{p.anomalies.length === 1 ? 'y' : 'ies'} this week</h3></header>
              <ul className="eb-results">{p.anomalies.map((a, i) => <li key={i} className={a.severity === 'CRITICAL' ? 'err' : 'warn'}>{a.message}</li>)}</ul>
            </section>
          )}

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Campaign movers</h3></header>
            {p.movers.length === 0 ? <EmptyNote title="No campaign activity this week" /> : (
              <ul className="eb-results">
                {p.movers.map((m, i) => (
                  <li key={i} className="ok"><b>{m.campaign}</b> — {eurC(m.feesCents)} fees · {eurC(m.salesCents)} sales · {m.sold} sold</li>
                ))}
              </ul>
            )}
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>What autopilot did ({p.autopilotApplied.length})</h3></header>
            {p.autopilotApplied.length === 0 ? <EmptyNote title="No autopilot actions" description="Rules in AUTOPILOT mode (with the global dial on AUTO) apply within guardrails and report here." /> : (
              <ul className="eb-results">{p.autopilotApplied.map((a, i) => <li key={i} className="ok">{a.kind.replace(/_/g, ' ')} · {a.entityRef.campaignName} · {a.entityRef.listingId ?? a.entityRef.keywordText ?? ''} — {a.result?.detail ?? ''}</li>)}</ul>
            )}
          </section>

          <section className="eb-panel">
            <header className="eb-panel-head">
              <h3>Awaiting your decision ({p.pendingProposals.length})</h3>
              <Link href="/marketing/ads/ebay/automation" className="eb-linkbtn">Open approval queue →</Link>
            </header>
            {p.pendingProposals.length === 0 ? <EmptyNote title="Queue is clear" /> : (
              <ul className="eb-results">{p.pendingProposals.slice(0, 10).map((pr) => <li key={pr.id} className="warn">{pr.kind.replace(/_/g, ' ')} · {pr.entityRef.campaignName} · {pr.entityRef.listingId ?? pr.entityRef.keywordText ?? ''}</li>)}</ul>
            )}
          </section>

          {(p.economics.MISSING_COGS ?? 0) > 0 && (
            <div className="eb-sandbox">
              <b>{p.economics.MISSING_COGS} listing(s) still lack cost data</b> — break-even guardrails and net-margin reporting stay partial until product costs land; those listings remain manual-only for automation.
            </div>
          )}
        </>
      )}
    </div>
  )
}
