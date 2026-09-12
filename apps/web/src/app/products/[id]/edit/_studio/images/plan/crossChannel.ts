/**
 * PES.7 — the cross-channel publish planner. Pure, tested.
 *
 * 🔴 **This exists because a five-market Amazon publish is not five publishes.**
 *
 * Inventory §4 finding A, and the Owner's D1 ruling on it: SP-API Listings image attributes are
 * **ASIN-global** — Amazon applies them to every marketplace "even if you specify the
 * marketplace_id selector". Xavia is Pan-EU, one ASIN across IT/DE/FR/ES/UK, so the five market
 * targets in this planner all write the *same* picture set. Firing them in sequence, which is what
 * the old 5-iteration loop did silently, leaves whichever ran last.
 *
 * D1 kept the per-market model in full (image TEXT is localized per market, and that is a real
 * need) and made the honest preview mandatory instead: **"the per-market publish UI must say which
 * mechanism each market's set rides."** That sentence is this module's whole job. The two
 * mechanisms that *can* deliver genuinely per-country images — Amazon's Country-Specific Upload,
 * and A+ Content — are not automated here, and the planner names them rather than letting an
 * operator conclude that picking a market gave them a per-market image set.
 */

/** How a target's pictures actually reach the channel. */
export type Mechanism = 'sp-api-global' | 'ebay-inventory' | 'shopify-media' | 'unsupported'

export interface PublishTarget {
  key: string
  channel: string
  marketplace: string | null
  mechanism: Mechanism
  /** Rows pinned to exactly this channel+market layer. */
  pinned: number
  /** Rows on the channel's all-markets layer that this target would also carry. */
  inherited: number
}

export interface TargetRow {
  platform: string | null
  marketplace: string | null
  amazonSlot: string | null
  url: string
}

export function mechanismFor(channel: string): Mechanism {
  switch (channel) {
    case 'AMAZON': return 'sp-api-global'
    case 'EBAY': return 'ebay-inventory'
    case 'SHOPIFY': return 'shopify-media'
    // A channel the studio has no image-publish path for. Named as unsupported rather than
    // silently omitted, so the planner never implies a channel is covered when it is not.
    default: return 'unsupported'
  }
}

export function buildTargets(args: {
  channels: readonly { id: string; markets: readonly string[] }[]
  listing: readonly TargetRow[]
}): PublishTarget[] {
  const { channels, listing } = args
  const out: PublishTarget[] = []

  for (const channel of channels) {
    const rows = listing.filter((r) => r.platform === channel.id && r.amazonSlot !== undefined)
    const inherited = rows.filter((r) => r.marketplace === null).length
    const mechanism = mechanismFor(channel.id)

    if (channel.markets.length === 0) {
      out.push({
        key: `${channel.id}:_`, channel: channel.id, marketplace: null, mechanism,
        pinned: inherited, inherited: 0,
      })
      continue
    }
    for (const market of channel.markets) {
      out.push({
        key: `${channel.id}:${market}`,
        channel: channel.id,
        marketplace: market,
        mechanism,
        pinned: rows.filter((r) => r.marketplace === market).length,
        inherited,
      })
    }
  }
  return out
}

/** Nothing to send at all. */
export function isEmpty(t: PublishTarget): boolean {
  return t.pinned === 0 && t.inherited === 0
}

/**
 * What a target actually writes to.
 *
 * 🔴 For the SP-API path this is the **ASIN**, not the marketplace — which is exactly why five
 * market targets are one destination.
 */
export function destinationOf(t: PublishTarget): string {
  return t.mechanism === 'sp-api-global' ? `${t.channel}:ASIN` : t.key
}

/** Targets that write the same destination. Only groups of more than one are returned. */
export function collisionGroups(targets: readonly PublishTarget[]): PublishTarget[][] {
  const byDestination = new Map<string, PublishTarget[]>()
  for (const t of targets) {
    if (isEmpty(t)) continue
    const d = destinationOf(t)
    byDestination.set(d, [...(byDestination.get(d) ?? []), t])
  }
  return [...byDestination.values()].filter((g) => g.length > 1)
}

export function mechanismNote(mechanism: Mechanism): string {
  switch (mechanism) {
    case 'sp-api-global':
      return 'Sends through the Listings API, which stores images against the ASIN. Amazon shows '
        + 'that one set in every marketplace — choosing a market here does not give that market its '
        + 'own pictures. Genuinely per-country images need Amazon’s Country-Specific Upload, and '
        + 'localized text belongs in A+ Content; neither is automated from this screen.'
    case 'ebay-inventory':
      return 'Sends through the eBay Inventory API. Each listing carries its own pictures.'
    case 'shopify-media':
      return 'Sends product media to Shopify. Each product carries its own pictures.'
    default:
      return 'This studio has no image publish path for this channel, so nothing here would be sent.'
  }
}

/** The sentence for a set of targets that overwrite one another. */
export function collisionSentence(group: readonly PublishTarget[]): string {
  const names = group.map((t) => t.marketplace ?? t.channel).join(', ')
  return `${names} all write the same set of pictures on ${group[0].channel}. Publishing them `
    + 'together does not give each one its own images — they run in order and whichever finishes '
    + 'last is what Amazon keeps.'
}

export interface PlanSummary {
  selected: number
  /** Distinct places the selection actually writes to. */
  destinations: number
  empty: number
  unsupported: number
}

export function summarisePlan(targets: readonly PublishTarget[]): PlanSummary {
  const live = targets.filter((t) => !isEmpty(t) && t.mechanism !== 'unsupported')
  return {
    selected: targets.length,
    destinations: new Set(live.map(destinationOf)).size,
    empty: targets.filter(isEmpty).length,
    unsupported: targets.filter((t) => t.mechanism === 'unsupported').length,
  }
}

/**
 * The headline above the cards.
 *
 * 🔴 States the count of DESTINATIONS, not the count of targets. "5 targets" reads as five
 * outcomes; "5 targets, 1 destination" is the fact the operator needs before pressing anything.
 */
export function planHeadline(summary: PlanSummary): string {
  if (summary.selected === 0) return 'Nothing selected.'
  if (summary.destinations === 0) return 'Nothing selected would send any pictures.'
  const targets = `${summary.selected} target${summary.selected === 1 ? '' : 's'}`
  const dest = `${summary.destinations} destination${summary.destinations === 1 ? '' : 's'}`
  return summary.selected === summary.destinations
    ? `${targets}, each writing somewhere different.`
    : `${targets}, but only ${dest} — some of them overwrite each other.`
}
