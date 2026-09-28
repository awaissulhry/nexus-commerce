/**
 * Every sentence the shared-stock screens show about a grant, an impact or a product switch. One place,
 * so the lend tab, the borrow tab and the switch preview can never describe the same thing two ways.
 * Written for a person who has never seen the schema: no status codes, no ids.
 */
import type { Grant, GrantImpact, GrantSide, ListingPreview, LenderAction, BorrowerDecision } from './stockPoolApi'
import { aliasMarkGlyph, aliasMarkName } from '@/design-system/primitives'
import { count, dateWords, type Tone } from './words'

function on(value: string | null | undefined): string {
  return value ? ` on ${dateWords(value)}` : ''
}

/** The status as the business in front of the screen should read it. */
export function grantStatusWords(grant: Grant, side: GrantSide): { label: string; tone: Tone; detail: string } {
  const other = side === 'lender' ? grant.workspaceName : grant.ownerWorkspaceName
  switch (grant.status) {
    case 'pending':
      return side === 'lender'
        ? { label: 'Waiting for an answer', tone: 'info', detail: `Offered${on(grant.createdAt)}. An owner of ${other} must accept.` }
        : { label: 'Offer to review', tone: 'info', detail: `Offered by ${other}${on(grant.createdAt)}.` }
    case 'active':
      return { label: 'On', tone: 'success', detail: `Accepted${on(grant.respondedAt)}.` }
    case 'paused':
      return side === 'lender'
        ? { label: 'Paused', tone: 'warning', detail: `You paused it${on(grant.pausedAt)}. ${other}’s listings do not use it until you resume.` }
        : { label: 'Paused', tone: 'warning', detail: `Paused by ${other}${on(grant.pausedAt)}. Your listings use your own stock until it resumes.` }
    case 'declined':
      return side === 'lender'
        ? { label: 'Declined', tone: 'neutral', detail: `${other} declined${on(grant.endedAt ?? grant.respondedAt)}.` }
        : { label: 'Declined', tone: 'neutral', detail: `You declined${on(grant.endedAt ?? grant.respondedAt)}.` }
    case 'revoked': {
      const byLender = grant.endedBySide === 'owner'
      const who = side === 'lender' ? (byLender ? 'You' : other) : (byLender ? other : 'You')
      const how = byLender ? (grant.respondedAt ? 'ended' : 'withdrew') : 'left'
      return { label: 'Ended', tone: 'neutral', detail: `${who} ${how} this shared stock${on(grant.endedAt)}.` }
    }
  }
}

export function warehousesWords(grant: Pick<Grant, 'locations'>): string {
  if (grant.locations.length === 0) return 'None'
  return grant.locations.map((l) => l.usable ? l.code : `${l.code} (closed: lends 0)`).join(' · ')
}

export function lenderActionLabel(grant: Grant, action: LenderAction): string {
  switch (action) {
    case 'pause': return 'Pause'
    case 'resume': return 'Resume'
    case 'end': return grant.status === 'pending' ? 'Withdraw offer' : 'End shared stock'
  }
}

export function borrowerActionLabel(action: BorrowerDecision): string {
  switch (action) {
    case 'accept': return 'Accept'
    case 'decline': return 'Decline'
    case 'leave': return 'Stop using this stock'
  }
}

/**
 * What a pause, an end or a leave does to the borrower's listings, from the impact counts. Only the
 * lines that apply; the first safety rule first: a listing never keeps an old number.
 */
export function impactLines(impact: GrantImpact, borrowerName: string): string[] {
  const l = impact.listings
  const v = impact.sharedVariants
  const lines: string[] = []
  if (impact.linkedProducts === 0) return [`No product of ${borrowerName} uses this stock. No listing changes.`]
  if (l.toZero) lines.push(`${count(l.toZero, 'listing')} ${l.toZero === 1 ? 'goes' : 'go'} to 0.`)
  if (l.toOwn) lines.push(`${count(l.toOwn, 'listing')} ${l.toOwn === 1 ? 'goes' : 'go'} to ${borrowerName}’s own stock.`)
  if (l.pinned) lines.push(`${count(l.pinned, 'listing')} ${l.pinned === 1 ? 'is' : 'are'} on a Fixed number and ${l.pinned === 1 ? 'keeps it' : 'keep it'}. A fixed number is not real stock.`)
  if (l.paused) lines.push(`${count(l.paused, 'listing')} ${l.paused === 1 ? 'is' : 'are'} Paused: nothing is sent, so the channel keeps its last number.`)
  if (l.closed) lines.push(`${count(l.closed, 'listing')} ${l.closed === 1 ? 'has' : 'have'} a closed offer and ${l.closed === 1 ? 'stays' : 'stay'} closed.`)
  if (l.fba) lines.push(`${count(l.fba, 'listing')} ${l.fba === 1 ? 'is' : 'are'} managed by Amazon (FBA) and never used this stock.`)
  if (v.toZero) lines.push(`${count(v.toZero, 'shared eBay variant')} ${v.toZero === 1 ? 'goes' : 'go'} to 0.`)
  if (v.toOwn) lines.push(`${count(v.toOwn, 'shared eBay variant')} ${v.toOwn === 1 ? 'goes' : 'go'} to ${borrowerName}’s own stock.`)
  if (v.excluded) lines.push(`${count(v.excluded, 'shared eBay variant')} ${v.excluded === 1 ? 'is' : 'are'} Excluded and ${v.excluded === 1 ? 'stays' : 'stay'} as ${v.excluded === 1 ? 'it is' : 'they are'}.`)
  if (lines.length === 0) lines.push('No listing of these products is live, so no number changes.')
  return lines
}

/** The consequence of a lender action, before the impact lines. */
export function lenderConsequence(grant: Grant, action: LenderAction): string {
  switch (action) {
    case 'pause': return `New sales in ${grant.workspaceName} stop using your stock. Orders already made still ship from your warehouse. You can resume at any time; the products stay switched.`
    case 'resume': return `${grant.workspaceName}’s switched products follow your stock again.`
    case 'end': return grant.status === 'pending'
      ? `The offer to ${grant.workspaceName} is withdrawn. Nothing was switched.`
      : `Shared stock ends for good. ${count(grant.linkedProducts, 'product')} in ${grant.workspaceName} go back to their own stock. Orders already made still ship from your warehouse. To lend again, make a new offer.`
  }
}

export function borrowerConsequence(grant: Grant, action: BorrowerDecision): string {
  switch (action) {
    case 'accept': return 'Nothing switches yet. You choose products one by one, and see the exact number each listing will show before you switch.'
    case 'decline': return `The offer from ${grant.ownerWorkspaceName} is declined. ${grant.ownerWorkspaceName} can offer again later.`
    case 'leave': return `This business stops using ${grant.ownerWorkspaceName}’s stock for good. ${count(grant.linkedProducts, 'product')} go back to your own stock. Orders already made still ship from ${grant.ownerWorkspaceName}’s warehouse.`
  }
}

/** One preview row: what the listing will show after the switch, and why. */
export function previewRuleWords(row: Pick<ListingPreview, 'rule' | 'willShow'>): string {
  switch (row.rule) {
    case 'follows': return row.willShow === null ? 'Follows the stock' : `Shows ${row.willShow}`
    case 'fixed': return 'Keeps its Fixed number'
    case 'paused': return 'Paused: nothing is sent'
    case 'excluded': return 'Excluded: nothing is sent'
    case 'amazon-managed': return 'Managed by Amazon (FBA): nothing is sent'
    case 'offer-closed': return 'Offer closed: nothing is sent'
    case 'not-counted': return 'Stock not counted: nothing is sent'
  }
}

const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', ETSY: 'Etsy' }

type ListingNameFacts = Pick<ListingPreview, 'channel' | 'marketplace' | 'itemId'> & Partial<Pick<ListingPreview, 'accountLabel' | 'listingMark' | 'aliasLabel'>>

/**
 * A listing's name in two parts, as the Media page names a destination: the channel, market and account, then —
 * only where that account and market hold more than one listing of the product — which listing it is.
 */
export function listingNameParts(row: ListingNameFacts): { head: string; name: string | null } {
  const channel = CHANNEL_NAMES[row.channel] ?? row.channel.charAt(0) + row.channel.slice(1).toLowerCase()
  const head = `${channel} ${row.marketplace}${row.accountLabel ? ` · ${row.accountLabel}` : ''}`
  if (row.itemId) return { head, name: `listing ${row.itemId}` }
  if (row.listingMark == null) return { head, name: null }
  return { head, name: row.listingMark === 0 ? 'Main listing' : row.aliasLabel ?? aliasMarkName(row.listingMark) }
}

export function listingName(row: ListingNameFacts): string {
  const { head, name } = listingNameParts(row)
  if (name === null) return head
  return `${head} · ${row.listingMark != null && !row.itemId ? `${aliasMarkGlyph(row.listingMark)} ` : ''}${name}`
}

export const COST_PRICE_MISSING =
  'No cost price in this business. Sales from shared stock count cost of goods from this business’s own cost price, so profit reports would show these sales at zero cost. Set a cost price on the product.'
