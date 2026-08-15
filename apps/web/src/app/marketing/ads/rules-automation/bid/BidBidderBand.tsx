'use client'

/**
 * BID.S1 — the bidder band: who owns each live campaign's bids, and the number nothing showed.
 *
 * The page's real finding, from the brief's own measurement: 41 ENABLED campaigns receive no bid
 * write from anything — 23.3% of live ad spend un-bid when measured — with their write gates
 * OPEN. Nothing is stopping a bidder from reaching them; nothing is trying. The band states that
 * per SCOPE, with this window's spend (labelled as such), and the split by bidder kind.
 *
 * `goal` at 0 is reachable-and-empty, not missing: no campaign sets `dynamicBidding.targetAcos`,
 * and the optimiser has no live source until NEXUS_BID_OPTIMIZER_SOURCE flips — which is S6's
 * assignment story, not this band's. Assignment (`?bidder=`) stays S6's.
 */
import { AlertTriangle } from 'lucide-react'
import type { BidSlotProps } from './slot-contract'

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const num = (n: number) => n.toLocaleString('en-IE')

export function BidBidderBand({ data, view, push }: BidSlotProps) {
  const c = data?.census
  if (!c?.bidders) return null
  const { bidders, noBidder } = c
  return (
    <div className="h10-bd1">
      <span className="h10-bd1-k">Bidders, per live campaign:</span>
      <span className="h10-bd1-seg" title="A rank schedule owns these campaigns' bids on its own clock.">
        <b>{num(bidders.schedule)}</b> schedule
      </span>
      <span className="h10-bd1-seg" title="A target-ACOS goal owns them. Zero is reachable-and-empty: no campaign sets dynamicBidding.targetAcos, and the optimiser has no live source yet.">
        <b>{num(bidders.goal)}</b> goal
      </span>
      <span className="h10-bd1-seg" title="A person wrote their bids recently; no automation owns them.">
        <b>{num(bidders.manual)}</b> manual
      </span>
      {noBidder.campaigns > 0 ? (
        <button
          type="button"
          className="h10-bd1-none"
          title={`No bid write from anything in 60 days. ${num(noBidder.gatesOpen)} of ${num(noBidder.campaigns)} have their write gate OPEN — nothing is stopping a bidder from reaching them, and nothing is trying. Click to see them at campaign grain.`}
          onClick={() => { if (view !== 'campaigns') push({ view: 'campaigns' }) }}
        >
          <AlertTriangle size={12} aria-hidden />
          <b>{num(noBidder.campaigns)}</b> no bidder — {eur(noBidder.spendCents)} spent in this window, {num(noBidder.gatesOpen)} gate{noBidder.gatesOpen === 1 ? '' : 's'} open
        </button>
      ) : (
        <span className="h10-bd1-seg ok">every live campaign in scope has a bidder</span>
      )}
    </div>
  )
}
