/**
 * Phase S3 — in-memory CSRF token store.
 *
 * The API returns a CSRF token in the body of GET /api/auth/csrf and on
 * login/accept (the web origin can't read the API-origin cookie, so the
 * token travels in the body). We keep it in memory and the fetch wrapper
 * echoes it in the x-nexus-csrf header on mutating API calls. Not
 * persisted — a page reload re-fetches it via the AuthProvider.
 */

let csrfToken: string | null = null

export function getCsrfToken(): string | null {
  return csrfToken
}

export function setCsrfToken(token: string | null): void {
  csrfToken = token
}
