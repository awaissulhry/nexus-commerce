/**
 * The page's own, non-secret cookies (language, theme, remembered company and site). The session and CSRF cookies are
 * the API's (`__Host-factory_session`, `__Host-factory_csrf`): only the API sets them; the page reads the CSRF one.
 */

/** A cookie's value from a `Cookie` header or `document.cookie`, or undefined. */
export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at < 0) continue
    if (part.slice(0, at).trim() !== name) continue
    const raw = part.slice(at + 1).trim()
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }
  return undefined
}

/** Reads a cookie in the browser. */
export function readCookie(name: string): string | undefined {
  return typeof document === 'undefined' ? undefined : cookieValue(document.cookie, name)
}

/** Writes a page cookie for the whole site: Lax, a year by default, Secure on https. */
export function writeCookie(name: string, value: string, maxAgeDays = 365): void {
  if (typeof document === 'undefined') return
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${Math.round(maxAgeDays * 86400)}; SameSite=Lax${secure}`
}
