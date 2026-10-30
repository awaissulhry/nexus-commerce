import { foldSearchText } from './text'

/**
 * "Why it matched" (design shell.search › All results: "why it matched (highlighted words)"): the parts of a shown text
 * that a query's words found, so the row can mark them. Pure, for the web: the API answers the query's folded words and
 * the entry's number, title and subtitle as stored; this finds each word inside the text with accents and case aside.
 * A word found by similarity only (a typo) marks nothing: the row then says it matched a similar word.
 */

export interface MatchedPart {
  readonly text: string
  readonly hit: boolean
}

/** One folded character per character of `text` (a letter with an accent folds to one letter; punctuation to a space). */
function foldEach(text: string): string[] {
  return [...text].map((char) => {
    if (char === '-' || char === '/' || char === '.') return char
    const folded = foldSearchText(char)
    return folded.length === 1 ? folded : ' '
  })
}

/** The text cut into parts, the parts the words found marked `hit` (longest words first; overlaps merged). */
export function matchedParts(text: string, words: readonly string[]): MatchedPart[] {
  const chars = [...text]
  if (chars.length === 0) return []
  const folded = foldEach(text)
  const marks = new Array<boolean>(chars.length).fill(false)
  for (const word of [...new Set(words.filter((entry) => entry.length > 0))].sort((a, b) => b.length - a.length)) {
    const needle = [...word]
    let from = 0
    for (;;) {
      const at = indexOfChars(folded, needle, from)
      if (at < 0) break
      for (let i = at; i < at + needle.length; i++) marks[i] = true
      from = at + needle.length
    }
  }
  const parts: MatchedPart[] = []
  for (let i = 0; i < chars.length; i++) {
    const last = parts[parts.length - 1]
    if (last && last.hit === marks[i]) parts[parts.length - 1] = { text: last.text + chars[i], hit: last.hit }
    else parts.push({ text: chars[i]!, hit: marks[i]! })
  }
  return parts
}

/** The first index (in characters) at or after `from` where the folded characters spell the needle. */
function indexOfChars(folded: readonly string[], needle: readonly string[], from: number): number {
  outer: for (let i = from; i + needle.length <= folded.length; i++) {
    for (let j = 0; j < needle.length; j++) if (folded[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** Whether any word is found as typed inside the text (else the match was by similarity: a typo forgiven). */
export function hasExactHit(texts: readonly (string | null | undefined)[], words: readonly string[]): boolean {
  return texts.some((text) => typeof text === 'string' && matchedParts(text, words).some((part) => part.hit))
}
