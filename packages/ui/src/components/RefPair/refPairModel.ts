/**
 * RefPair's rules (B-W2b-155), pure: which references are drawn and in what order (the partner's own first, ours second,
 * an empty one left out), the parts of a value around a search match (case and accents ignored), and the pair as one line
 * of text.
 */

export interface RefSide {
  side: 'theirs' | 'ours'
  label: string
  value: string
}

const clean = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const v = value.trim()
  return v === '' ? null : v
}

/** The references to draw: theirs first, ours second; a missing or blank one is left out. */
export function refPairSides(theirs: string | null | undefined, ours: string | null | undefined, labels: { theirs: string; ours: string }): RefSide[] {
  const out: RefSide[] = []
  const t = clean(theirs)
  const o = clean(ours)
  if (t) out.push({ side: 'theirs', label: labels.theirs, value: t })
  if (o) out.push({ side: 'ours', label: labels.ours, value: o })
  return out
}

/** One character folded for matching: lower case, no accent; a character that would fold to more than one stays itself. */
const foldChar = (ch: string): string => {
  const folded = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  return Array.from(folded).length === 1 ? folded : ch
}

export interface MatchPart {
  text: string
  match: boolean
}

/**
 * A value cut around every place the search text appears (case and accents ignored; spaces at the ends of the search
 * ignored). No search, or no match: the value as one part.
 */
export function refMatchParts(value: string, search: string | null | undefined): MatchPart[] {
  const needle = typeof search === 'string' ? Array.from(search.trim()).map(foldChar) : []
  const chars = Array.from(value)
  if (!needle.length || needle.length > chars.length) return [{ text: value, match: false }]
  const hay = chars.map(foldChar)
  const parts: MatchPart[] = []
  let from = 0
  let i = 0
  while (i <= hay.length - needle.length) {
    if (needle.every((c, k) => hay[i + k] === c)) {
      if (i > from) parts.push({ text: chars.slice(from, i).join(''), match: false })
      parts.push({ text: chars.slice(i, i + needle.length).join(''), match: true })
      i += needle.length
      from = i
    } else i++
  }
  if (!parts.length) return [{ text: value, match: false }]
  if (from < chars.length) parts.push({ text: chars.slice(from).join(''), match: false })
  return parts
}

/** The pair as one line ("Your PO 4500-1234 · Our ref. SO-2026-0042"); one side alone when the other is missing. */
export function refPairText(sides: readonly RefSide[], join: (theirs: string, ours: string) => string): string {
  const words = sides.map((s) => `${s.label} ${s.value}`)
  return words.length === 2 ? join(words[0], words[1]) : (words[0] ?? '')
}
