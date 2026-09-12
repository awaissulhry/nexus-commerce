/**
 * VP.4 — §9's copy table, verbatim, in ONE place.
 *
 * §9 opens "one source for every lane", and the fastest way to break that is five components each
 * interpolating the same sentence slightly differently. Every string the channel projection puts on
 * screen is built here, and the §9 line it comes from is quoted above it.
 *
 * 🔴 **A limit may be `null`** — VP.2's contract §1: "no limit we can source", and it says so rather
 * than inventing one. Amazon has no sourced variant cap. So every sentence below that names a limit
 * has a branch for its absence, and the branch DROPS the clause rather than printing `null`, `∞` or
 * a number from the spec table that nothing in this repository stands behind.
 *
 * Pure — no React, no DOM — so the layout gate and a unit test can both read the exact sentence.
 */
import type { ProjectionVocabulary } from './types'

/**
 * The channel's own plural — from the WIRE, because `property` does not pluralise with `+ s` and
 * VP.2 sends `axisNounPlural` for exactly that reason. The fallback exists for a coordinate whose
 * vocabulary predates that field and is the only place this file adds an `s`.
 */
export function axisNounPlural(vocabulary: Pick<ProjectionVocabulary, 'axisNoun' | 'axisNounPlural'>): string {
  if (vocabulary.axisNounPlural) return vocabulary.axisNounPlural
  return vocabulary.axisNoun.endsWith('s') ? vocabulary.axisNoun : `${vocabulary.axisNoun}s`
}

/**
 * §9 mapping band: `<n> of <limit> <axisNoun>s`.
 *
 * With no sourced limit the count still has to be stated, so it reads `2 specifics` — a true
 * sentence with one fact instead of a false one with two.
 */
export const mappedCount = (mapped: number, limit: number | null, vocabulary: Pick<ProjectionVocabulary, 'axisNoun' | 'axisNounPlural'>): string =>
  limit === null ? `${mapped} ${axisNounPlural(vocabulary)}` : `${mapped} of ${limit} ${axisNounPlural(vocabulary)}`

/** §4.4.1's tag: `2 of 5 used`, or `2 used` where no limit is sourced. */
export const usedCount = (mapped: number, limit: number | null): string =>
  limit === null ? `${mapped} used` : `${mapped} of ${limit} used`

/**
 * §9 mapping band: `One listing · <n> of <m> variants included · <m> of <limit> allowed`.
 *
 * Returned in PIECES because the canvas bolds the counts and a component cannot bold the inside of
 * a string it was handed. The separator is the band's, not this function's. `allowed` is `null`
 * when the channel states no sourced variant cap — the band then drops that clause entirely, which
 * is VP.2's contract §1 in one line: "the UI then omits the 'of N allowed' half".
 */
export interface MappingSentence {
  listings: string
  included: { count: number; of: string }
  allowed: { count: number; of: string } | null
}

export function mappingSentence(listings: number, includedCount: number, total: number, limit: number | null): MappingSentence {
  return {
    listings: listings === 1 ? 'One listing' : `${listings} listings`,
    included: { count: includedCount, of: `of ${total} variants included` },
    allowed: limit === null ? null : { count: total, of: `of ${limit} allowed` },
  }
}

/** §4.2 toolbar count: `<n> rows · <k> included`. The rows half is `SheetToolbar`'s own. */
export const includedDescriptor = (included: number): string => ` · ${included} included`

/** §9 toolbar chips (channel). */
export const CHIP_LABELS = {
  excluded: 'Excluded',
  pinned: 'Pinned values',
  mappingErrors: 'Mapping errors',
} as const

/** §9 dock. `<Channel> · <Market> mapping` — built on the server's own coordinate label. */
export const dockTitle = (coordinateLabel: string): string => `${coordinateLabel} mapping`

/**
 * §4.4's dock sub-line: `GALE-JACKET · 20 variants · 1 listing · <account>`.
 *
 * The account is dropped when the coordinate has no label for it rather than printed as "—": a
 * dangling separator reads as a missing value, which is a different claim from "this coordinate has
 * one account and it is unnamed".
 */
export function dockSubtitle(sku: string, variants: number, listings: number, account: string | null | undefined): string {
  return [
    sku,
    `${variants} ${variants === 1 ? 'variant' : 'variants'}`,
    `${listings} ${listings === 1 ? 'listing' : 'listings'}`,
    account || null,
  ].filter((part): part is string => !!part).join(' · ')
}

/** §4.4.1, verbatim. The limit and the noun come from the wire — §4.5, never hardcoded. */
export function specificsHint(channelLabel: string, vocabulary: ProjectionVocabulary, limit: number | null): string {
  const head = `Each shared axis becomes one ${channelLabel} ${vocabulary.axisNoun}. Drag to set the order buyers pick in.`
  return limit === null ? head : `${head} ${channelLabel} allows up to ${limit}.`
}

/** §4.4.2, verbatim. */
export const VALUES_HINT = 'Specific values follow the shared axis values. Pin a different value on a variant in the grid.'

/** §4.4.2's one-line note for an axis whose values are identical to the shared ones. */
export const sameAsSharedNote = (axisLabel: string, values: number, included: number): string =>
  `${axisLabel} · ${values} values · same as shared · ${included} included`

/** §4.4.3, verbatim — with each unsourced limit dropped rather than invented. */
export function splitHint(channelLabel: string, variants: number | null, axes: number | null, vocabulary: ProjectionVocabulary): string {
  const limits = [
    variants === null ? null : `${variants} variations`,
    axes === null ? null : `${axes} ${axisNounPlural(vocabulary)} per listing`,
  ].filter((part): part is string => !!part)
  const head = `How this family lands on ${channelLabel}.`
  return limits.length ? `${head} Limits: ${limits.join(', ')}.` : head
}

/** §4.4.3's two radio labels. */
export const splitSingleLabel = (included: number, limit: number | null): string =>
  limit === null ? `One listing — ${included} variations` : `One listing — ${included} of ${limit} variations`
export const splitPerAxisLabel = (axisLabel: string, listings: number, counts: number[]): string =>
  `One listing per ${axisLabel} — ${listings} listings · ${counts.join(' + ')}`

/** §4.4.4's banner title. The REASON is the server's sentence, never composed here. */
export const LOCK_TITLE = 'Specifics lock once the listing is live'
