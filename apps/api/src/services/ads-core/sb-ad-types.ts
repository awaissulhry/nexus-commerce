/**
 * P4.5f — the Sponsored Brands creative types, and which of them Amazon deprecated.
 *
 * ## What is established, and what is not
 *
 * **Established (P0.8, 2026-09-19, from Amazon's own release-notes feed):** on
 * **2026-07-06** Amazon deprecated the Sponsored Brands *"Product collection"* ad
 * entity in favour of *Manual / Auto Collection*. Amazon's own note says
 * **"deprecated" with no shutdown date**.
 *
 * **Reported, NOT confirmed on Amazon's pages:** a full shut-off in **January 2027**,
 * and that since **September 2026** newly created Product Collection campaigns are
 * **auto-converted to Manual Collection**. Both come from third-party write-ups
 * (ecomcrew, ecomranker, checked 2026-09-21). P0.8 recorded the January 2027 date with
 * the same caveat.
 *
 * 🔴 **What is NOT established is the wire value.** Amazon's API reference for
 * `POST /sb/v4/ads` renders only with JavaScript — P0.8 hit the same wall on the
 * deprecations page — so two web checks on 2026-09-21 could not produce the `adType`
 * enum for Manual or Auto Collection, nor confirm the casing of the existing ones.
 *
 * Our client sends `adType: 'productCollection'`, and every *other* enum it sends on
 * SB v4 is upper-cased (`state: (…).toUpperCase()`). That is a smell, not a finding:
 * `/sb/v4/ads` has **0 calls in `OutboundApiCallLog`** — the create path has never run
 * — so there is no stored Amazon answer to derive the vocabulary from either.
 *
 * ## So this file records the vocabulary; it does not invent one
 *
 * Replacing a known-deprecated value with an unverified one, on a path that has never
 * run, trades a value Amazon still accepts for a guess. `productCollection` stays the
 * wire value for that entity. What changes is that nothing **defaults** to it: see
 * `createSbAdLocal`.
 *
 * To close this properly, one of: a captured 200 from a real `POST /sb/v4/ads`, or the
 * `adType` enum read off Amazon's rendered API reference.
 */

export type SbAdType = 'productCollection' | 'storeSpotlight' | 'video'

export interface SbAdTypeSpec {
  /** Exactly what goes on the wire as `adType`. Never re-derived at a call site. */
  wire: string
  /** What an operator calls it. */
  label: string
  /** null when Amazon has not deprecated it. */
  deprecated: null | { on: string; inFavourOf: string; shutdownDate: string | null; source: string }
}

export const SB_AD_TYPES: Record<SbAdType, SbAdTypeSpec> = {
  productCollection: {
    wire: 'productCollection',
    label: 'Product collection',
    deprecated: {
      on: '2026-07-06',
      inFavourOf: 'Manual Collection or Auto Collection',
      // Amazon's own note carries no date. A January 2027 shut-off is third-party only.
      shutdownDate: null,
      source: "Amazon Ads release notes 2026-07-06, via build/P0.8.md — 'deprecated', no date given",
    },
  },
  storeSpotlight: { wire: 'storeSpotlight', label: 'Store spotlight', deprecated: null },
  video: { wire: 'video', label: 'Video', deprecated: null },
}

export const SB_AD_TYPE_KEYS = Object.keys(SB_AD_TYPES) as SbAdType[]

/** The ad types an operator should be offered for a NEW creative: the undeprecated ones. */
export const SB_AD_TYPES_CURRENT = SB_AD_TYPE_KEYS.filter((k) => SB_AD_TYPES[k].deprecated === null)

/**
 * The wire value for an ad type, refusing anything this file does not name.
 *
 * A deprecated type is still SENT — Amazon deprecated it, it did not remove it, and a
 * refusal here would break an operator deliberately matching an existing campaign's
 * format. The caller logs the deprecation; see `sbAdTypeNotice`.
 */
export function sbAdTypeWire(type: string): string {
  const spec = SB_AD_TYPES[type as SbAdType]
  if (!spec) {
    throw new Error(
      `[ads] "${type}" is not a Sponsored Brands creative type (${SB_AD_TYPE_KEYS.join(', ')}) — nothing was sent`,
    )
  }
  return spec.wire
}

/** A sentence for the log when a deprecated type is used, or null. */
export function sbAdTypeNotice(type: string): string | null {
  const d = SB_AD_TYPES[type as SbAdType]?.deprecated
  if (!d) return null
  return (
    `Sponsored Brands "${SB_AD_TYPES[type as SbAdType].label}" was deprecated on ${d.on} ` +
    `in favour of ${d.inFavourOf}` +
    (d.shutdownDate ? `, and shuts off on ${d.shutdownDate}` : ' (Amazon has announced no shutdown date)') +
    `. Source: ${d.source}`
  )
}
