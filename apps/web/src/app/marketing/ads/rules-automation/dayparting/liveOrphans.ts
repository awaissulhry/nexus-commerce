/**
 * Owner 2026-10-04 (before 2a merges) — the rank loop never changes bids on a live campaign by itself. A live campaign
 * that still carries a bid floor or a base-bid change Rank & Dayparting made, with no schedule or plan holding it any
 * more, is listed on the Rank & Dayparting list instead, and a person gives each one back
 * (GET /advertising/rank-release/enabled-orphans, POST …/:campaignId/release). The words those screens show.
 */
import type { ActionImpact } from '@/design-system/grid/actions/registry'

export interface LiveOrphanBid {
  kind: 'ad-group' | 'target'
  id: string
  /** The ad group's name (its default bid), or the target: keyword and match type, ASIN or category. */
  label: string
  adGroup: string
  currentCents: number
  backCents: number
}
export interface LiveOrphan {
  campaignId: string
  name: string
  marketplace: string | null
  /** Why it is listed, in words, as the API says it. */
  reasons: string[]
  floor: { by: string | null; byWords: string; since: string; floorCents: number | null } | null
  deltaBids: number
  adGroups: number
  targets: number
  bids: LiveOrphanBid[]
}
/** GET /advertising/rank-release/enabled-orphans, as the API sends it. */
export interface LiveOrphanList {
  campaigns: number
  bids: number
  /** Why a give-back would wait right now (ads automation stopped, Rank & Dayparting switched off); null = at once. */
  waitWhy: string | null
  items: LiveOrphan[]
}
/** POST /advertising/rank-release/enabled-orphans/:campaignId/release, as the API answers it. */
export interface LiveOrphanRelease {
  campaignId: string
  name: string
  outcome: 'restored' | 'nothing' | 'kept-by-others' | 'failed' | 'deferred'
  writes: number
  deferredWhy: string | null
}

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
/** A bid in the market's currency, as Amazon shows it (0.35). */
export const bidText = (cents: number) => (cents / 100).toFixed(2)
const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** The banner's lead line. */
export function liveOrphanHeadline(campaigns: number): string {
  return `${n(campaigns, 'live campaign')} still ${campaigns === 1 ? 'carries' : 'carry'} bids rank changed.`
}

/** The banner's body: why nothing gives them back by itself. */
export function liveOrphanWhy(campaigns: number): string {
  const them = campaigns === 1 ? 'it' : 'them'
  return `No rank schedule or plan holds ${them} any more, and the rank loop never changes a live campaign by itself. Review ${them} and give the bids back one campaign at a time.`
}

/** Under a campaign's name: its market and why it is listed. */
export function liveOrphanLine(o: LiveOrphan): string {
  return [o.marketplace ?? 'No market', ...o.reasons.map(capital)].join(' · ')
}

/** The short table in the review dialog: the first `max` bids (now → goes back to), then how many more there are. */
export function liveOrphanRows(o: LiveOrphan, max = 5): Array<{ id: string; cells: string[] }> {
  const rows = o.bids.slice(0, max).map((b) => ({ id: b.id, cells: [bidLabel(b), bidText(b.currentCents), bidText(b.backCents)] }))
  if (o.bids.length > max) rows.push({ id: 'more', cells: [`and ${n(o.bids.length - max, 'more bid')}, every one shown before it changes`, '', ''] })
  return rows
}

function bidLabel(b: LiveOrphanBid): string {
  return b.kind === 'ad-group' ? `${b.label} (ad group default bid)` : `${b.label} · ${b.adGroup}`
}

/**
 * The confirmation before one campaign's bids are given back. While a give-back would wait (ads automation stopped,
 * Rank & Dayparting switched off) it says why and cannot be confirmed: the click would change nothing.
 */
export function giveBackImpact(o: LiveOrphan, waitWhy: string | null): ActionImpact {
  const title = `Give back the bids on ${o.name}?`
  if (waitWhy) return { level: 'none', title, unavailable: `Nothing can be given back right now because ${waitWhy}. Try again once that changes.` }
  return {
    level: 'confirm',
    title,
    consequences: [
      `${n(o.bids.length, 'bid')} on this live campaign ${o.bids.length === 1 ? 'changes' : 'change'} on Amazon now (${n(o.adGroups, 'ad group default bid')}, ${n(o.targets, 'target')}), to the values in the table below.`,
      `Why it is listed: ${o.reasons.join('; ')}.`,
      'Only bids change: placement percentages, the budget and the campaign’s status stay as they are.',
    ],
    reach: 'channel',
    reversal: { verb: 'Set the bids again by hand', fidelity: 'lossy' },
    acknowledge: 'I understand these bids change on Amazon at once, on a live campaign.',
    review: { title: `Bids on ${o.name}`, rows: o.bids.map((b) => ({ label: bidLabel(b), before: bidText(b.currentCents), after: bidText(b.backCents) })) },
  }
}

/** After a give-back, in words. */
export function giveBackOutcome(r: LiveOrphanRelease): { tone: 'success' | 'warning'; text: string } {
  if (r.outcome === 'restored') return { tone: 'success', text: `Gave back ${n(r.writes, 'bid')} on ${r.name}.` }
  if (r.outcome === 'failed') return { tone: 'warning', text: `Gave back ${n(r.writes, 'bid')} on ${r.name}, but not every one: the rest stay as they are and the campaign stays on this list, so try again.` }
  if (r.outcome === 'deferred') return { tone: 'warning', text: `Nothing changed on ${r.name}: the give-back waits because ${r.deferredWhy ?? 'ads automation is stopped'}. Try again once that changes.` }
  return { tone: 'warning', text: `Nothing changed on ${r.name}: it no longer carries bids rank changed.` }
}
