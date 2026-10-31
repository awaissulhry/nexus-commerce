/**
 * Textarea counter — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * A limit COUNTS, it never blocks typing: a person may paste a long draft and cut it down. Characters are counted the
 * way a person sees them (grapheme clusters, `Intl.Segmenter`), so an emoji or an accented letter built from two code
 * points is one character, not two.
 */

// `Intl.Segmenter` is in every browser and Node this app runs on, but not in the web app's TypeScript lib: typed here.
interface GraphemeSegmenter { segment(input: string): Iterable<unknown> }
type SegmenterConstructor = new (locale: string, options: { granularity: 'grapheme' }) => GraphemeSegmenter

let segmenter: GraphemeSegmenter | null | undefined

function graphemes(): GraphemeSegmenter | null {
  if (segmenter === undefined) {
    const Segmenter = typeof Intl !== 'undefined' ? (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter : undefined
    segmenter = Segmenter ? new Segmenter('en', { granularity: 'grapheme' }) : null
  }
  return segmenter
}

/** How many characters a person sees in `text`. */
export function countCharacters(text: string | null | undefined): number {
  if (!text) return 0
  const seg = graphemes()
  if (!seg) return Array.from(text).length
  return Array.from(seg.segment(text)).length
}

/** How many characters over the limit (0 when within it, or when there is no limit). */
export function charactersOver(used: number, limit: number | null | undefined): number {
  return limit != null && Number.isFinite(limit) && limit >= 0 ? Math.max(0, used - limit) : 0
}

/** The counter's words: "312 / 500". */
export function counterWords(used: number, limit: number): string {
  return `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')}`
}

/** What an over-long text is told: "38 characters too long", "1 character too long". */
export function overWords(over: number): string {
  return `${over.toLocaleString('en-US')} ${over === 1 ? 'character' : 'characters'} too long`
}

export interface TextareaCount {
  used: number
  over: number
  /** The counter's text: "312 / 500", or "512 / 500 · 12 characters too long". */
  text: string
}

export function textareaCount(
  text: string | null | undefined,
  limit: number,
  label: (used: number, limit: number) => string = counterWords,
  /** The over-limit words (B-W2b-04: the person's language). Default "38 characters too long". */
  tooLong: (over: number) => string = overWords,
): TextareaCount {
  const used = countCharacters(text)
  const over = charactersOver(used, limit)
  return { used, over, text: over > 0 ? `${label(used, limit)} · ${tooLong(over)}` : label(used, limit) }
}
