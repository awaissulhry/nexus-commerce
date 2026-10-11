/**
 * Bid page, Bids view (lane BIDS, 2026-10-10). The Bid page's [Rules | Bids] switch mounts it:
 *
 *   <BidsView market={market} viewSwitch={<SegmentedControl … />} show={tile} onTotals={setBidTotals} />
 *
 * Props: `market` (a two-letter code; null or 'all' = every market), optional `productId` / `campaignId` /
 * `adGroupId` to narrow it, `viewSwitch` (drawn at the start of its toolbar), `refreshKey` (bump to read again),
 * `show` (a tile's filter: 'changed7d' · 'contested' · 'waiting') and `onTotals` (called after each read with
 * `BidsTotals`: bids · changed7d · contested · waiting · owners · truncated — never narrowed by the view's own filters).
 */
export { BidsView, type BidsViewProps } from './BidsView'
export { BIDS_SHOWS, isBidsShow, type BidsShow, type BidsTotals } from './bidsModel'
