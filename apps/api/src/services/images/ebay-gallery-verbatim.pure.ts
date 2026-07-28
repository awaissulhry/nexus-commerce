/**
 * The ONE verbatim-curation rule, shared by everything that turns a curated
 * bucket into a gallery: the eBay image publish AND the listing-description
 * renderer.
 *
 * OPERATOR RULE (2026-07-27, explicit): images from the shared "cover & common"
 * pool may be reused in ANY row and ANY position. What is curated in Nexus is
 * what the buyer sees, verbatim and in order.
 *
 * Both call sites used to subtract the shared pool from every per-colour set
 * (the old "P5 de-dupe"), on the theory that a photo would otherwise appear
 * twice. That theory was wrong in both places:
 *
 *  - PUBLISH: the group gallery and a variation's gallery are separate strips.
 *    The filter silently corrupted live listings — GALE-JACKET-ALT2 curated 7
 *    photos per colour and published 6, because each colour's hero was also the
 *    cover shot, so eBay promoted a marketing tile to Principale. Removed
 *    2026-07-27.
 *  - DESCRIPTION: the "Colori disponibili" section is the per-colour truth, not
 *    a diff against the hero. The same filter dropped 114 of 459 curated images
 *    across 20 of 26 families — REGAL-JACKET's Nero set rendered 1 of 3 photos
 *    because its FIRST (the main colour shot) was also the cover, and
 *    WATERPROOF-OVERJACKET-BLACK-MEN lost its only colour section entirely.
 *
 * Living here — one module, imported by both — is what keeps them from drifting
 * again: reintroducing a filter on either side now means editing this file and
 * failing ebay-image-dedupe.vitest.test.ts / ebay-description-render.vitest.test.ts
 * together.
 */
export function galleryForCuratedRow(urls: string[]): string[] {
  return [...urls]
}
