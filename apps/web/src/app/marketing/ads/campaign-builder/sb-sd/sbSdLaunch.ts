/**
 * W2-D — the Sponsored Brands / Display builder's launch logic, pure so it is tested without a browser.
 *
 * CC-11: the creative types this builder can send, with the limits Amazon's Sponsored Brands 4.0 document sets on each
 * (the API's `sbCreativeProblems` is the authority and is asked before anything is created; these drive the screen).
 * Store spotlight needs store pages and video needs a video, which Nexus cannot send, so they are not offered.
 *
 * CC-11 / CC-12: when a launch stops part-way, the screen lists what already exists on Amazon. Nothing is deleted for the
 * operator: he decides whether to finish, keep or archive it.
 */

export type SbCreativeChoice = 'manualCollection' | 'productCollection'

export interface SbCreativeSpec {
  key: SbCreativeChoice
  label: string
  detail: string
  asinsMin: number
  asinsMax: number
  /** What the text beside the logo is called for this type, and how long it may be. */
  headlineLabel: 'Title' | 'Headline'
  headlineMax: number
}

export const SB_CREATIVE_CHOICES: readonly SbCreativeSpec[] = [
  {
    key: 'manualCollection', label: 'Manual collection',
    detail: "Amazon's current format: your logo, a title and 3 to 10 products you choose.",
    asinsMin: 3, asinsMax: 10, headlineLabel: 'Title', headlineMax: 32,
  },
  {
    key: 'productCollection', label: 'Product collection',
    detail: 'The older format: your logo, a headline and up to 3 products. Amazon deprecated it on 6 July 2026 but still accepts it.',
    asinsMin: 1, asinsMax: 3, headlineLabel: 'Headline', headlineMax: 50,
  },
]

export const sbCreativeSpec = (key: SbCreativeChoice): SbCreativeSpec =>
  SB_CREATIVE_CHOICES.find((c) => c.key === key) ?? SB_CREATIVE_CHOICES[0]

/** The ASINs the creative will carry: the first ones picked, up to the type's limit (the screen says when some are left out). */
export function sbCreativeAsins(picked: readonly string[], key: SbCreativeChoice): string[] {
  return picked.slice(0, sbCreativeSpec(key).asinsMax)
}

/** What stops this creative on the screen, before the API's own check; empty when it may be previewed. */
export function sbCreativeScreenProblems(key: SbCreativeChoice, headline: string, pickedCount: number): string[] {
  const spec = sbCreativeSpec(key)
  const out: string[] = []
  const count = Math.min(pickedCount, spec.asinsMax)
  if (count < spec.asinsMin) out.push(`A ${spec.label.toLowerCase()} needs at least ${spec.asinsMin} product${spec.asinsMin === 1 ? '' : 's'}; ${pickedCount} picked.`)
  const text = headline.trim()
  if (!text) out.push(`Write a ${spec.headlineLabel.toLowerCase()}.`)
  else if (text.length > spec.headlineMax) out.push(`Amazon allows ${spec.headlineMax} characters in a ${spec.label.toLowerCase()} ${spec.headlineLabel.toLowerCase()}.`)
  return out
}

/** CC-12 — the windows Amazon lists for a "viewed" audience (`POST /sd/targets`). */
export const SD_VIEWS_LOOKBACK_DAYS = [7, 14, 30, 60, 90] as const

/** One thing a launch made on Amazon (it has Amazon's id). */
export interface LiveOnAmazon { what: string; amazonId?: string | null }

/**
 * CC-11 — the words for a launch that stopped part-way: what exists on Amazon now, and that nothing was deleted.
 * `live` lists only what Amazon holds; with nothing there the launch left nothing behind on Amazon.
 */
export function partlyMadeSummary(live: readonly LiveOnAmazon[], why: string): { title: string; items: string[]; note: string } {
  const items = live.map((l) => (l.amazonId ? `${l.what} (Amazon ${l.amazonId})` : l.what))
  if (items.length === 0) {
    return { title: `Not made: ${why}`, items: [], note: 'Nothing was created on Amazon.' }
  }
  return {
    title: `Partly made: ${why}`,
    items,
    note: 'These exist on Amazon now and cannot serve until the missing part is added. Nothing was deleted: keep and finish them, or archive them from the Campaigns list.',
  }
}
