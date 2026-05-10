// MC.1.4 — recent search persistence. Browser-local only; we
// deliberately do not push the search history server-side because (a)
// it leaks operator intent across operators on the same workspace
// and (b) the value is nearly zero — "did I just search for this?"
// is a 5-second working-memory question, not an analytics dataset.

const KEY = 'nexus:marketing-content:recent-searches'
const MAX = 6

export function readRecentSearches(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === 'string').slice(0, MAX)
      : []
  } catch {
    return []
  }
}

export function pushRecentSearch(value: string): string[] {
  if (typeof window === 'undefined') return []
  const trimmed = value.trim()
  if (!trimmed) return readRecentSearches()
  const prev = readRecentSearches()
  const next = [
    trimmed,
    ...prev.filter((v) => v.toLowerCase() !== trimmed.toLowerCase()),
  ].slice(0, MAX)
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    /* localStorage full or disabled — ignore */
  }
  return next
}

export function clearRecentSearches() {
  if (typeof window === 'undefined') return
  window.localStorage.removeItem(KEY)
}
