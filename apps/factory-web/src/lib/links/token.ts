/**
 * A one-off link arrives as `<web>/l#token=<tenantId>.<partyId>.<linkId>.<secret>` (apps/factory-api platform/links).
 * The token is in the FRAGMENT: browsers never send a fragment to a server, so no access log, proxy or referrer holds it.
 * The page reads it once, removes it from the address bar (a screenshot or a copied address must not carry it), and
 * sends it to the API only in the `x-factory-link` header.
 */

/** The token of a `#token=…` fragment (with or without `#`), or null. */
export function linkTokenFromHash(hash: string | null | undefined): string | null {
  if (!hash) return null
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')?.trim()
  // The API's shape: four dot-separated parts. Anything else opens nothing; it is not sent.
  return token && /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){3}$/.test(token) && token.length <= 200 ? token : null
}

/** Reads the token from this page's address and takes it out of the address bar. Browser only. */
export function takeLinkTokenFromLocation(): string | null {
  const token = linkTokenFromHash(window.location.hash)
  if (window.location.hash) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
  return token
}
