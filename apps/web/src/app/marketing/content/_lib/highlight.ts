// MC.1.4 — text highlighting helper.
// Splits a string into [before, match, after] segments based on a
// case-insensitive substring search. Returning null when there is no
// match lets callers skip the wrapping JSX entirely.

export interface HighlightSegments {
  before: string
  match: string
  after: string
}

export function splitForHighlight(
  text: string,
  query: string,
): HighlightSegments | null {
  if (!query) return null
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return null
  return {
    before: text.slice(0, idx),
    match: text.slice(idx, idx + query.length),
    after: text.slice(idx + query.length),
  }
}
