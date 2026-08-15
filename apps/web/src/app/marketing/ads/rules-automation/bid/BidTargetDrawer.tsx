'use client'

/**
 * BID.S3 — one target, in full: the drawer `?target=` opens.
 *
 * The grid's first column is a real link now (S3 deleted the two CSS rules that un-blued it),
 * and this is where it lands. Two data paths, honestly distinguished:
 *   · the target is IN the loaded grid → everything renders from the row + the payload's own
 *     series (no second fetch, no chance of disagreeing with the grid);
 *   · a deep link outside the current scope/filters → the curve is fetched by id
 *     (`bid-history?entityIds=`), and the drawer SAYS the identity facts are not in this view
 *     rather than inventing them.
 *
 * The curve is a WRITE LIST first and a sparkline second: a bid is a step function (it holds
 * until something writes it), so the honest detail is each write — when, from→to, and whether
 * it LANDED (a recorded cut that never reached Amazon renders as exactly that). 79% of targets
 * have no write in 60 days; that renders as its own sentence, never as an empty box.
 */
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ExternalLink, X } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { BidSpark } from './BidSpark'
import { resolveBidStates } from './bidState'
import type { BidSeriesPoint, BidTargetRow } from './types'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const num = (n: number) => n.toLocaleString('en-IE')
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })

export function BidTargetDrawer({ targetId, row, series, onClose }: {
  targetId: string
  row: BidTargetRow | null
  series: BidSeriesPoint[] | undefined
  onClose: () => void
}) {
  const [fetched, setFetched] = useState<BidSeriesPoint[] | null>(null)
  const [fetchErr, setFetchErr] = useState<string | null>(null)

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
  }, [onClose])

  // Deep-link path only: the grid payload has no series for a row it is not showing.
  useEffect(() => {
    if (row || series) return
    let alive = true
    ;(async () => {
      try {
        const r = await fetch(`${getBackendUrl()}/api/advertising/bid-history?entityIds=${encodeURIComponent(targetId)}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(`(${r.status})`)
        const j = await r.json()
        if (alive) setFetched((j?.series?.[targetId] as BidSeriesPoint[] | undefined) ?? [])
      } catch (e) { if (alive) setFetchErr((e as Error).message) }
    })()
    return () => { alive = false }
  }, [targetId, row, series])

  const curve = series ?? fetched ?? undefined
  const chips = row ? resolveBidStates(row, 99) : []

  return (
    <div className="h10-au-back" onClick={onClose}>
      <div className="h10-au-drawer" role="dialog" aria-modal="true" aria-label={`Target — ${row?.label ?? targetId}`} onClick={(e) => e.stopPropagation()}>
        <div className="h10-au-dh">
          <div>
            <b>{row ? row.label : 'Target'}</b>
            <span>
              {row
                ? <>{row.kind.replace(/_/g, ' ').toLowerCase()} · {row.match.replace(/_/g, ' ').toLowerCase()} · {row.market}{row.derived && ' · name derived from its targeting group'}</>
                : 'outside the current view'}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} aria-hidden /></button>
        </div>
        <div className="h10-au-db">
          {!row && (
            <p className="h10-au-conf" role="note">
              <AlertTriangle size={13} aria-hidden />
              This target is not in the current view&rsquo;s scope or filters, so its identity, bid and
              metrics are not loaded — only its write history below. Clear the filters to see the row.
            </p>
          )}

          {row && (
            <section className="h10-au-def">
              <div className="h10-au-defrow">
                <span className="k">Where</span>
                <span className="v">
                  <Link href={`/marketing/ads/campaigns/${row.campaignId}`}>{row.campaignName} <ExternalLink size={11} aria-hidden /></Link>
                  {' '}› {row.adGroupName}
                  {!row.liveNow && <em className="h10-bd3-off"> — not in any auction (target or campaign not enabled)</em>}
                </span>
              </div>
              <div className="h10-au-defrow">
                <span className="k">Bid</span>
                <span className="v">
                  <b>{eur(row.bidCents)}</b>
                  {row.minBidCents != null || row.maxBidCents != null
                    ? <> · band {row.minBidCents != null ? eur(row.minBidCents) : 'no floor declared'} – {row.maxBidCents != null ? eur(row.maxBidCents) : 'no ceiling declared'}</>
                    : <> · <em className="h10-bd3-mut">no band declared</em></>}
                  {row.bidder !== 'none' && <> · bidder: {row.bidderName ?? row.bidder}</>}
                </span>
              </div>
              {chips.length > 0 && (
                <div className="h10-au-defrow">
                  <span className="k">States</span>
                  <span className="v h10-bd3-chips">
                    {chips.map((c) => <i key={c.key} className={`h10-bd3-chip ${c.tone}`} title={c.title}>{c.label}</i>)}
                  </span>
                </div>
              )}
              <div className="h10-au-defrow">
                <span className="k">Window</span>
                <span className="v">
                  {row.measured
                    ? <>{num(row.impressions)} impressions · {num(row.clicks)} clicks · {eur(row.spendCents)} spent · {eur(row.salesCents)} sales · {row.orders} orders · ACOS {row.acos != null ? `${(row.acos * 100).toFixed(0)}%` : '—'}</>
                    : <em className="h10-bd3-mut">not served in this window — which is not the same as spending nothing</em>}
                </span>
              </div>
            </section>
          )}

          <section className="h10-bd3-curve">
            <h4>The bid, over 60 days</h4>
            {fetchErr && <p className="h10-au-limiterr" role="alert"><AlertTriangle size={13} aria-hidden /> Could not load the write history: {fetchErr}</p>}
            {curve === undefined && !fetchErr && <p className="h10-bd3-mut">Loading…</p>}
            {curve !== undefined && curve.length === 0 && (
              <p className="h10-bd3-mut">
                No write in 60 days — nobody and nothing has touched this bid in the window. That is
                a fact about the bid, not a gap in the record.
              </p>
            )}
            {curve !== undefined && curve.length > 0 && (
              <>
                <div className="h10-bd3-spark">
                  <BidSpark points={curve} label={row?.label ?? targetId} format={(n) => eur(n)} />
                </div>
                <table className="h10-bd3-writes">
                  <thead><tr><th>When</th><th>Change</th><th>Landed</th></tr></thead>
                  <tbody>
                    {[...curve].reverse().map((p, i) => (
                      <tr key={`${p.at}-${i}`} className={p.delivered === 'FAILED' ? 'failed' : ''}>
                        <td>{when(p.at)}</td>
                        <td>{p.from != null ? `${eur(p.from)} → ` : ''}{eur(p.to)}</td>
                        <td>{p.delivered === 'SUCCESS' ? 'yes' : p.delivered === 'FAILED' ? <b title="Recorded here and never accepted by Amazon — the bid did not move.">no</b> : p.delivered === 'PENDING' ? 'pending' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
