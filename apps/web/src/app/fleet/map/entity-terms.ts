/**
 * NAF.SB.M.6 — parsing `properties.on`, the evidence behind a derived relationship.
 *
 * Its own module, and not a private helper inside `EntityListView.tsx`, for one
 * reason: that file imports the design system, and the vitest runner in
 * apps/web has no `@/` alias — so a helper living there cannot be tested. This
 * one has no imports at all.
 *
 * S6.i — the shape it must survive. `on` is a LIST:
 *
 *   kw:<term>|<TYPE>, kw:<term>|<TYPE>, …
 *
 * up to ten terms in one value on production. S6.c read it with
 * `/^kw:(.*)\|([A-Z]+)$/`, and `.*` is greedy, so against a list that anchored
 * pattern matched the FIRST and LAST field and swallowed every separator in
 * between — printing the wire format into a column that exists to hide it.
 * A regex anchored at both ends looks like it validates the whole string; it
 * does not tell you the cardinality of what it matched.
 */

export interface EvidenceTerm {
  term: string
  type: string
}

export function termsOf(on: string): EvidenceTerm[] {
  return on
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((t) => {
      /* `[^|]*`, not `.*` — the field cannot contain the separator it ends on. */
      const m = /^kw:([^|]*)\|([A-Z]+)$/.exec(t)
      /* An unexpected shape shows itself rather than being swallowed — the same
         rule this page applies to an id it cannot resolve. */
      return m ? { term: m[1], type: m[2].toLowerCase() } : { term: t, type: '' }
    })
}
