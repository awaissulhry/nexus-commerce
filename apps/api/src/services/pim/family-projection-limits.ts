/**
 * VP.2 — per-channel vocabulary, limits and target options for the Variants page.
 *
 * Spec `docs/2026-09-11-variants-page-spec.md` §4.5, contract `docs/vp2-contracts.md` §1.
 *
 * The reason this file exists: the projection layer is the place where one shared family becomes each
 * channel's own idea of a variation. eBay calls them SPECIFICS and takes five; Amazon calls it a THEME and the
 * theme is a single enum value chosen from the product type's schema; Shopify calls them OPTIONS and lets you
 * name them anything. A page that hardcodes "5" or the word "specifics" is wrong on three channels out of four,
 * so every number and every noun is SERVED.
 *
 * 🔴 Two of these numbers are PINNED to the code that enforces them, not copied from a document:
 * `family-projection-limits.vitest.test.ts` asserts that `parseThemeAxes` truncates at `EBAY.axes` and that
 * `ebay-variation-preflight`'s `MAX_VARIANTS` equals `EBAY.variants`. A list of members is a set claim: if the
 * enforcing code moves, the test fails rather than this page quietly stating a stale number.
 *
 * Shopify's and Etsy's four numbers have no enforcing code in this repository, so there is nothing to pin them
 * to. They come from the spec's §4.5 table and say so in `source`, which is the honest state of that knowledge.
 */
import { parseThemeAxes } from '../ebay-theme-axes.js'
import { EBAY_MAX_VARIANTS_PER_LISTING } from '../ebay-variation-preflight.js'

export interface ProjectionVocabulary {
  /** Singular, lower case. */
  axisNoun: string
  /** Sent explicitly: 'property' does not pluralise with +s, and the copy needs the plural. */
  axisNounPlural: string
  /** The mapping dock's section-1 title for this channel (spec §9). */
  sectionTitle: string
}

export interface ProjectionLimits {
  /** Max axes per listing. `null` = this channel states no limit we can source. */
  axes: number | null
  /** Max variants per listing. `null` = no sourced limit — the UI omits the "of N allowed" half. */
  variants: number | null
  source: { axes: string | null; variants: string | null }
}

export interface TargetOption {
  /** The value stored in the mapping: the eBay specific name, the SP-API attribute, the Shopify option name. */
  code: string
  /** What the operator reads in the Listbox — the channel's own localised label. */
  label: string
  /** The sheet column this option came from, when it came from one. */
  columnKey: string | null
  /** True when a shared axis is already mapped onto it. Filled by the projection read. */
  taken: boolean
}

const VOCABULARY: Record<string, ProjectionVocabulary> = {
  EBAY: { axisNoun: 'specific', axisNounPlural: 'specifics', sectionTitle: 'Variation specifics' },
  AMAZON: { axisNoun: 'theme', axisNounPlural: 'themes', sectionTitle: 'Variation theme' },
  SHOPIFY: { axisNoun: 'option', axisNounPlural: 'options', sectionTitle: 'Options' },
  ETSY: { axisNoun: 'property', axisNounPlural: 'properties', sectionTitle: 'Properties' },
}

/**
 * An unknown channel gets the neutral word rather than a guessed one. "axis" is what this codebase calls the
 * concept internally, and an operator reading it on a channel we have not modelled learns the truth — that we
 * do not know that channel's noun — instead of being told it is an eBay specific.
 */
const UNKNOWN_VOCABULARY: ProjectionVocabulary = { axisNoun: 'axis', axisNounPlural: 'axes', sectionTitle: 'Variation axes' }

export function vocabularyFor(channel: string): ProjectionVocabulary {
  return VOCABULARY[channel.toUpperCase()] ?? UNKNOWN_VOCABULARY
}

/** eBay's two numbers, read from the two places that enforce them. */
export const EBAY_MAX_AXES = 5
export { EBAY_MAX_VARIANTS_PER_LISTING }

const SPEC_TABLE = 'spec §4.5 — no enforcing constant exists in this repository'

/**
 * `themeOptions` is the product type's `variation_theme` enum for an Amazon coordinate — the only place
 * Amazon's axis count can be derived from. The largest segment count in the enum IS the cap: a theme with four
 * segments exists (`STYLE/MODEL_NUMBER/NUMBER_OF_ITEMS/PART_NUMBER` on OUTERWEAR·IT), so a hardcoded 3 would
 * refuse a combination Amazon itself offers.
 */
export function limitsFor(channel: string, themeOptions: string[] = []): ProjectionLimits {
  switch (channel.toUpperCase()) {
    case 'EBAY':
      return {
        axes: EBAY_MAX_AXES,
        variants: EBAY_MAX_VARIANTS_PER_LISTING,
        source: {
          axes: 'ebay-theme-axes.ts — parseThemeAxes truncates the declared theme at this many axes',
          variants: 'ebay-variation-preflight.ts — MAX_VARIANTS, the preflight that refuses a larger family',
        },
      }
    case 'AMAZON': {
      const widest = themeOptions.reduce((max, option) => Math.max(max, option.split('/').length), 0)
      return {
        axes: widest > 0 ? widest : null,
        // Amazon states no variant cap we can source. `null` means NOT KNOWN, which is a different fact from a
        // large number — and the UI renders the sentence without the "of N allowed" half rather than inventing
        // one. Reporting a plausible ceiling here would be an invention an operator could not check.
        variants: null,
        source: {
          axes: widest > 0 ? "the product type's own variation_theme enum — the widest combination it offers" : null,
          variants: null,
        },
      }
    }
    case 'SHOPIFY':
      return { axes: 3, variants: 100, source: { axes: SPEC_TABLE, variants: SPEC_TABLE } }
    case 'ETSY':
      return { axes: 2, variants: 70, source: { axes: SPEC_TABLE, variants: SPEC_TABLE } }
    default:
      return { axes: null, variants: null, source: { axes: null, variants: null } }
  }
}

/** True when the channel takes free-text target names instead of a closed list (Shopify). */
export function isFreeformTarget(channel: string): boolean {
  return channel.toUpperCase() === 'SHOPIFY'
}

/**
 * Re-exported so the pinning test and the projection read use ONE parser for the declared eBay theme. The
 * declared theme is a comma/slash/pipe/semicolon-separated string on `Product.variationTheme`; re-deriving a
 * "simple split" one file away is how two surfaces end up disagreeing about a family's axis set.
 */
export { parseThemeAxes }
