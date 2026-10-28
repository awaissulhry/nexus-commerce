/**
 * Is this connection URL on this machine? The factory's env loaders refuse any other database or Redis host when they
 * run locally or in tests, so a developer machine can never reach a shared or production server by a wrong `.env`.
 *
 * Fail closed: a URL that cannot be read, a Unix socket path, several hosts, or a `host` / `hostaddr` query parameter
 * that points elsewhere (libpq and node-postgres let it override the host part) all count as "not loopback".
 */

/** 127.0.0.0/8, ::1 and localhost. Brackets around an IPv6 literal are accepted. */
export function isLoopbackHost(host: string): boolean {
  const name = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1')
  if (name === 'localhost' || name === '::1') return true
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)
  return octets !== null && octets.slice(1).every((part) => Number.parseInt(part, 10) <= 255)
}

/** True only when every host the URL could connect to is a loopback host. */
export function isLoopbackUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.hostname === '' || !isLoopbackHost(url.hostname)) return false
  for (const key of ['host', 'hostaddr']) {
    for (const value of url.searchParams.getAll(key)) {
      if (!isLoopbackHost(value)) return false
    }
  }
  return true
}

/** `host:port/database` for error messages: never the user name or the password. */
export function describeUrlHost(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.host || '(no host)'}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return '(unreadable URL)'
  }
}
