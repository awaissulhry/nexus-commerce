'use client'

/**
 * ER3.5 — the weekly review with history: 12-week picker (stored payloads
 * render what was true then), movers as an aligned mini-table, per-proposal
 * deep links into the hub's Suggestions tab, honest "All markets" label,
 * week-over-week ▲▼ deltas. Generate now / Mark reviewed semantics unchanged.
 */
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import '../ebay.css'
import { postEbayAds, getEbayAds, eurC, pctP, intlN } from '../_lib'

interface DigestPayload {
  week: { start: string; end: string }
  totals: { adFeesCents: number; salesCents: number; clicks: number; impressions: number; soldQty: number; acosPct: number | null }
  prior: { adFeesCents: number; salesCents: number; soldQty: number }
  // ER4 E2 — present on digests generated after 2026-07-04; older weeks lack it
  byMarketplace?: Array<{ marketplace: string; adFeesCents: number; salesCents: number; soldQty: number; acosPct: number | null }>
  movers: Array<{ campaign: string; feesCents: number; salesCents: number; sold: number }>
  autopilotApplied: Array<{ kind: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string }; result?: { detail?: string } | null }>
  pendingProposals: Array<{ id: string; kind: string; entityRef: { campaignName?: string; listingId?: string; keywordText?: string } }>
  anomalies: Array<{ type: string; severity: string; message: string }>
  economics: Record<string, number>
  generatedAt: string
}
interface DigestRow { id: string; weekStart: string; reviewedAt: string | null; payload: DigestPayload }
interface DigestMeta { id: string; weekStart: string; generatedAt: string; reviewedAt: string | null }

function EmptyNote({ title, description }: { title: string; description?: string }) {
  return (
    <div style={{ padding: '20px 8px', textAlign: 'center' }}>
      <p style={{ fontSize: 13, fontWeight: 600, color: '#475467', margin: 0 }}>{title}</p>
      {description && <p style={{ fontSize: 12, color: '#8a93a1', margin: '4px 0 0' }}>{description}</p>}
    </div>
  )
}

/** ER3.5 — WoW delta chip, dashboard idiom (goodUp: is an increase good?) */
function Wow({ cur, prev, goodUp }: { cur: number; prev: number; goodUp: boolean }) {
  if (prev <= 0) return null
  const pctD = ((cur - prev) / prev) * 100
  const up = pctD >= 0
  return <span className={`dd ${up === goodUp ? 'up' : 'down'}`} title="vs prior week">{up ? '▲' : '▼'} {Math.abs(pctD).toFixed(0)}%</span>
}

export function EbayDigestClient() {
  const [weeks, setWeeks] = useState<DigestMeta[]>([])
  const [digest, setDigest] = useState<DigestRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async (id?: string) => {
    setLoading(true)
    try {
      const [list, d] = await Promise.all([
        getEbayAds<{ digests: DigestMeta[] }>('/digests'),
        id ? getEbayAds<{ digest: DigestRow }>(`/digests/${id}`) : getEbayAds<{ digest: DigestRow | null }>('/digest/latest'),
      ])
      setWeeks(list.digests)
      setDigest(d.digest)
      setError(null)
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
    try { await postEbayAds(`/digest/${digest.id}/reviewed`, {}); await reload(digest.id) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const p = digest?.payload
  const maxMoverFees = p ? Math.max(...p.movers.map((m) => m.feesCents), 1) : 1

  return (
    <div className="eb-page h10-am">
      <AdsPageHeader channel="ebay" title="eBay Weekly Digest"
        subtitle="The one weekly review: money, movers, what autopilot did, what needs your decision. Aggregated across every eBay marketplace."
        markets={[]} market="all" onMarketChange={() => {}} />
      <div className="eb-controls">
        {weeks.length > 0 && (
          <span className="eb-week-chips" role="tablist" aria-label="Digest weeks">
            {weeks.map((w) => (
              <button key={w.id} type="button" role="tab" aria-selected={digest?.id === w.id}
                className={`eb-kind-chip ${digest?.id === w.id ? 'on' : ''}`}
                title={w.reviewedAt ? `Reviewed ${new Date(w.reviewedAt).toLocaleDateString('en-GB')}` : 'Not yet reviewed'}
                onClick={() => void reload(w.id)}>
                {new Date(w.weekStart).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' })}{w.reviewedAt ? ' ✓' : ''}
              </button>
            ))}
          </span>
        )}
        <span style={{ flex: 1 }} />
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
            <header className="eb-panel-head"><h3>Week {p.week.start} → {p.week.end}</h3><span className="eb-panel-note">all markets · any-click attribution · generated {new Date(p.generatedAt).toLocaleString('en-GB')}</span></header>
            <div className="eb-headstats">
              <div><span className="k">Ad fees</span><span className="v">{eurC(p.totals.adFeesCents)} <Wow cur={p.totals.adFeesCents} prev={p.prior.adFeesCents} goodUp={false} /></span></div>
              <div><span className="k">Ad sales</span><span className="v">{eurC(p.totals.salesCents)} <Wow cur={p.totals.salesCents} prev={p.prior.salesCents} goodUp /></span></div>
              <div><span className="k">eBay ACOS</span><span className="v">{pctP(p.totals.acosPct)}</span></div>
              <div><span className="k">Clicks</span><span className="v">{intlN(p.totals.clicks)}</span></div>
              <div><span className="k">Impressions</span><span className="v">{intlN(p.totals.impressions)}</span></div>
              <div><span className="k">Sold</span><span className="v">{intlN(p.totals.soldQty)} <Wow cur={p.totals.soldQty} prev={p.prior.soldQty} goodUp /></span></div>
            </div>
            {p.byMarketplace && p.byMarketplace.length > 0 && (
              <div className="eb-mkt-split">
                {p.byMarketplace.map((m) => (
                  <span key={m.marketplace} className="eb-mkt-chip" title={`${m.marketplace} — week fees / sales / sold${m.acosPct != null ? ` · ACOS ${m.acosPct}%` : ''}`}>
                    <b>{m.marketplace.replace('EBAY_', '')}</b> {eurC(m.adFeesCents)} fees · {eurC(m.salesCents)} sales · {m.soldQty} sold{m.acosPct != null ? ` · ${m.acosPct}%` : ''}
                  </span>
                ))}
              </div>
            )}
          </section>

          {p.anomalies.length > 0 && (
            <section className="eb-panel" style={{ borderColor: '#f0d9a8', background: '#fdf6e3' }}>
              <header className="eb-panel-head"><h3 style={{ color: '#7a5b00' }}>{p.anomalies.length} anomal{p.anomalies.length === 1 ? 'y' : 'ies'} this week</h3></header>
              <ul className="eb-results">{p.anomalies.map((a, i) => <li key={i} className={a.severity === 'CRITICAL' ? 'err' : 'warn'}>{a.message}</li>)}</ul>
            </section>
          )}

          <section className="eb-panel">
            <header className="eb-panel-head"><h3>Campaign movers</h3><span className="eb-panel-note">by week ad fees</span></header>
            {p.movers.length === 0 ? <EmptyNote title="No campaign activity this week" /> : (
              <table className="eb-movers">
                <thead><tr><th>Campaign</th><th>Ad fees</th><th>Ad sales</th><th>Sold</th><th aria-label="Share of week" /></tr></thead>
                <tbody>
                  {p.movers.map((m, i) => (
                    <tr key={i}>
                      <td className="nm" title={m.campaign}>{m.campaign}</td>
                      <td className="num">{eurC(m.feesCents)}</td>
                      <td className="num">{eurC(m.salesCents)}</td>
                      <td className="num">{intlN(m.sold)}</td>
                      <td className="bar"><span style={{ width: `${Math.round((m.feesCents / maxMoverFees) * 100)}%` }} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
              <Link href="/marketing/ads/ebay/automation?tab=suggestions" className="eb-linkbtn">Open approval queue →</Link>
            </header>
            {p.pendingProposals.length === 0 ? <EmptyNote title="Queue is clear" /> : (
              <ul className="eb-results">
                {p.pendingProposals.slice(0, 10).map((pr) => (
                  <li key={pr.id} className="warn">
                    <Link className="eb-digest-plink" href={`/marketing/ads/ebay/automation?tab=suggestions&highlight=${pr.id}`}
                      title="Open this suggestion in the approval queue">
                      {pr.kind.replace(/_/g, ' ')} · {pr.entityRef.campaignName} · {pr.entityRef.listingId ?? pr.entityRef.keywordText ?? ''} →
                    </Link>
                  </li>
                ))}
              </ul>
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
