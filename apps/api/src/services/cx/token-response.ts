/** Shorter than the refresh lease, including time spent reading the response body. */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000

export function parseTokenResponse(text: string): Record<string, unknown> & { access_token: string } {
  const token: unknown = JSON.parse(text)
  if (!token || typeof token !== 'object' || Array.isArray(token)) throw new Error('Invalid token response')
  const value = token as Record<string, unknown>
  if (typeof value.access_token !== 'string' || !value.access_token.trim()) throw new Error('Missing access token')
  if (value.refresh_token != null && (typeof value.refresh_token !== 'string' || !value.refresh_token.trim())) throw new Error('Invalid refresh token')
  if (value.scope != null && typeof value.scope !== 'string') throw new Error('Invalid granted scopes')
  return value as Record<string, unknown> & { access_token: string }
}

export function tokenLifetime(value: unknown, fallback: number | null): number | null {
  if (value == null) return fallback
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) throw new Error('Invalid token lifetime')
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(new Date(Date.now() + seconds * 1000).getTime())) throw new Error('Invalid token lifetime')
  return seconds
}
