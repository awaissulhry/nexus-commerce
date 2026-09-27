/**
 * TOOLBAR REBUILD (Owner, 2026-09-27: "it should remember always") — the content languages this operator last picked,
 * per scope.
 *
 * Kept like the last market (`lastMarket.ts`): in the browser, read before the first sheet request would be wasted on
 * the wrong languages. The key is the scope on Shared (its languages are every market's) and `scope · market` on a
 * channel (a channel's languages are its market's). A link that names languages always wins; this only fills a URL
 * that names none.
 *
 * Best-effort: a private window or blocked storage throws or returns null, and the studio then opens on its default.
 */

const KEY = 'nexus:studio:languages:v1'

export function languagesKey(scope: string, market: string | null): string {
  return scope === 'master' ? 'master' : `${scope}:${market ?? ''}`
}

function readAll(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}

/** The remembered languages for `key`, restricted to `supported` and in its order; null when none apply. */
export function readLastLanguages(key: string, supported: readonly string[]): string[] | null {
  const stored = readAll()[key]
  if (!Array.isArray(stored)) return null
  const chosen = new Set(stored.filter((code): code is string => typeof code === 'string'))
  const usable = supported.filter((code) => chosen.has(code))
  return usable.length ? usable : null
}

export function writeLastLanguages(key: string, codes: readonly string[]): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [key]: [...codes] }))
  } catch {
    /* not remembering is not an error worth surfacing */
  }
}

/**
 * The URL patch for a language pick: ONE language is the ordinary sheet (`?locale=`), two or more split every text
 * field into one column per language (`?locales=`). Never both, so the URL has one reading.
 */
export function languagesPatch(codes: readonly string[]): { locale: string | undefined; locales: string | undefined } {
  return codes.length === 1 ? { locale: codes[0], locales: undefined } : { locale: undefined, locales: codes.join(',') }
}
