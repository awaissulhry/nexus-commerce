'use client'

/**
 * ⛔ PARKED 2026-08-18 (U3) — NOT MOUNTED, NOT DELETED.
 *
 * What it is: the per-query drawer (?row=query@market), including the parser-week flag.
 * Why it left: the Share of Voice tab is now Helium 10's shape — one rules grid and nothing else
 *   (`SovRulesClient.tsx`; study `docs/2026-08-16-ra-h10-reference-study.md` §3.9, §7.4).
 * Candidate home: travels with the query grid into Analytics › Coverage.
 *
 * Nothing here was changed and no endpoint was retired (`/share-of-voice-page` and its row route are
 * still served). The file stays at this path on purpose: re-mounting it is one import.
 * Manifest: `docs/2026-08-16-ra-parked-sections.md`.
 */

/**
 * SOV.5 — the row drawer: one query's whole story, deep-linkable as `?row=<query>@<market>`.
 *
 * Owns what SOV.1 §9 moved here: the weekly SERIES (every period, the pre-ACR.0.2 parser weeks
 * flagged so a fake collapse is annotated, never plotted as fact), CART-ADD and PURCHASE share
 * (2.9% / 0.2% row coverage made them drawer facts, not columns), WHICH ASIN holds the term this
 * week, and the campaigns buying it — observed (search-term spend, 30d) stated apart from declared
 * (an ENABLED keyword target), because a declared bid that never serves is its own finding.
 */
import { useEffect, useState } from 'react'
import { ToolbarButton } from '@/design-system/primitives'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface SeriesPoint {
  asOf: string
  share: number | null
  clickShare: number | null
  cartAddShare: number | null
  purchaseShare: number | null
  ourImpressions: number
  marketImpressions: number
  marketVolume: number
  periodParsed: boolean
}
interface Detail {
  query: string
  market: string
  scope: { boundBy: string; asins: number; asinScoped: boolean }
  series: SeriesPoint[]
  holders: Array<{ asin: string; ourImpressions: number; ourClicks: number }>
  buying: {
    observed: Array<{ campaignId: string; campaign: string; impressions: number; clicks: number; spendCents: number }>
    declared: Array<{ campaignId: string; campaign: string; match: string; bidCents: number }>
  }
}

const num = (n: number) => n.toLocaleString('en-IE')
const pct = (v: number | null): string => (v == null ? '—' : v > 0 && v < 0.0001 ? '<0.01%' : `${(v * 100).toFixed(2)}%`)
const dayMonth = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export function SovRowDrawer({ query, market, scope, onClose }: {
  query: string
  market: string
  scope: { line: string; portfolio: string; campaign: string }
  onClose: () => void
}) {
  const [d, setD] = useState<Detail | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  useEffect(() => {
    let alive = true
    const p = new URLSearchParams({ query, market })
    for (const [k, v] of Object.entries(scope)) if (v) p.set(k, v)
    fetch(`${getBackendUrl()}/api/advertising/share-of-voice-page/row?${p}`, { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error(`(${r.status})`); return r.json() })
      .then((j) => { if (alive) { setD(j as Detail); setErr(null) } })
      .catch((e) => { if (alive) setErr((e as Error).message) })
    return () => { alive = false }
  }, [query, market, scope.line, scope.portfolio, scope.campaign])

  const newest = d?.series.length ? d.series[d.series.length - 1] : null
  const maxShare = d ? Math.max(0.0001, ...d.series.map((s) => s.share ?? 0)) : 1

  return (
    <div className="h10-au-back" onClick={onClose}>
      <div className="h10-au-drawer" role="dialog" aria-modal="true" aria-label={`Share of voice — ${query}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-au-dh">
          <div>
            <b>{query}</b>
            <span>{market} · share of voice{d?.scope.asinScoped ? ` · ${d.scope.asins} scoped ASINs` : ' · whole market'}</span>
          </div>
          <ToolbarButton className="h10-au-close" icon={<X size={18} aria-hidden />} label="Close" tooltip={false} onClick={onClose} />
        </div>
        <div className="h10-au-db">
          {err != null ? (
            <p className="h10-plc2-err" role="alert"><AlertTriangle size={13} aria-hidden /> The drawer failed to load {err}.</p>
          ) : d == null ? (
            <p className="h10-plc2-muted">Loading…</p>
          ) : (
            <>
              <section className="h10-sov5-series">
                <h4>Every measured week — impression share</h4>
                {d.series.length === 0 ? (
                  <p className="h10-plc2-muted">Brand Analytics has never reported this query for the scoped ASINs.</p>
                ) : (
                  <ul>
                    {d.series.map((s) => (
                      <li key={s.asOf} className={s.periodParsed ? '' : 'unparsed'}>
                        <span className="nw">{dayMonth(s.asOf)}</span>
                        <span className="bar"><i style={{ width: `${Math.min(100, ((s.share ?? 0) / maxShare) * 100)}%` }} /></span>
                        <b>{pct(s.share)}</b>
                        <span className="sub">{num(s.ourImpressions)} of {num(s.marketImpressions)}</span>
                        {!s.periodParsed && <span className="flag" title="The pre-2026-08 parser wrote 0 for every our-side count in this whole market week. This zero is the defect, not a collapse.">parser week</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {newest != null && (
                <section className="h10-sov5-funnel">
                  <h4>The funnel, week of {dayMonth(newest.asOf)}</h4>
                  <p>
                    impression share <b>{pct(newest.share)}</b> · click share <b>{pct(newest.clickShare)}</b> ·{' '}
                    cart-add share <b>{pct(newest.cartAddShare)}</b> · purchase share <b>{pct(newest.purchaseShare)}</b>
                  </p>
                  <p className="h10-plc2-foot">Cart-add and purchase share live here, not as grid columns: our side carries a cart-add on ~3% of query-weeks and a purchase on ~0.2% — a dash column is a promise the data cannot keep.</p>
                </section>
              )}

              <section className="h10-sov5-holders">
                <h4>Who holds it{newest ? ` (week of ${dayMonth(newest.asOf)})` : ''}</h4>
                {d.holders.length === 0 ? (
                  <p className="h10-plc2-muted">No scoped ASIN carries an impression on this query this week.</p>
                ) : (
                  <ul>
                    {d.holders.map((h) => (
                      <li key={h.asin}><b>{h.asin}</b> — {num(h.ourImpressions)} impressions · {num(h.ourClicks)} clicks</li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="h10-sov5-buying">
                <h4>Who is buying it</h4>
                {d.buying.observed.length === 0 && d.buying.declared.length === 0 ? (
                  <p className="h10-plc2-muted">Nothing: no search-term spend in 30 days and no enabled keyword target. If this query holds organic share, that is the unbid finding.</p>
                ) : (
                  <>
                    {d.buying.observed.length > 0 && (
                      <ul>
                        {d.buying.observed.map((o) => (
                          <li key={o.campaignId}>
                            <Link href={`/marketing/ads/campaigns/${o.campaignId}`}>{o.campaign} <ExternalLink size={11} aria-hidden /></Link>
                            {' '}— €{(o.spendCents / 100).toFixed(2)} · {num(o.impressions)} impr · {num(o.clicks)} clicks (30d, observed)
                          </li>
                        ))}
                      </ul>
                    )}
                    {d.buying.declared.filter((t) => !d.buying.observed.some((o) => o.campaignId === t.campaignId)).length > 0 && (
                      <p className="h10-plc2-foot">
                        Declared but not serving in 30 days:{' '}
                        {d.buying.declared.filter((t) => !d.buying.observed.some((o) => o.campaignId === t.campaignId))
                          .map((t) => `${t.campaign} (${t.match.toLowerCase()}, €${(t.bidCents / 100).toFixed(2)})`).join(' · ')}
                        {' '}— a bid that never serves is its own finding.
                      </p>
                    )}
                  </>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
