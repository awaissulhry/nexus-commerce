/**
 * PES.4 — shared display formatters for the drawer panes.
 *
 * Small, but shared deliberately: a second copy of `when()` in a second pane is how two surfaces
 * end up printing the same instant two ways, and it is the same duplication #307 was about at a
 * larger scale. One definition, so History and Listings cannot disagree about what a timestamp
 * looks like.
 */

export { ago, when } from '@/design-system/grid/renderers/format'

/**
 * The over-cap sentence, naming the source that imposed the cap (DS1-25 / #426).
 *
 * 🔴 "over the channel cap" was hardcoded on both drawer surfaces while the reading carried
 * `capFrom` all along. On a master scope there is no channel at all, so the phrase asserted a
 * source that did not exist; on a channel scope it named the wrong granularity — the binding cap
 * comes from a specific marketplace ("Amazon · DE"), not from "the channel" in general.
 *
 * Where `capFrom` is absent, it says **source not stated** rather than inventing one. DS.1's
 * wording, kept verbatim so the three surfaces (validator, mark, drawer) read alike. Absent does
 * not occur on any scope measured so far — which is exactly why it must not fall back to a
 * plausible guess: the first time it happens, nobody will be looking.
 */
export function overCapNote(capFrom: string | null | undefined): string {
  return capFrom ? ` — over the ${capFrom} cap` : ' — over the cap (source not stated)'
}
