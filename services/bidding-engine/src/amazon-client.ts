/**
 * Minimal Amazon Ads API write client for the bidding worker. Owns the LWA
 * token lifecycle (cached + refreshed) and the v3 Sponsored Products keyword-bid
 * PUT. A 429 is surfaced as a typed `ThrottleError` carrying the server's
 * Retry-After so the worker can delay precisely instead of guessing.
 */
import { config } from './config.js'

export class ThrottleError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`amazon-429 retry_after=${retryAfterMs}ms`)
    this.name = 'ThrottleError'
  }
}

interface CachedToken { accessToken: string; expiresAt: number }

export class AmazonAdsClient {
  private token: CachedToken | null = null

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.accessToken
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.amazon.refreshToken,
      client_id: config.amazon.lwaClientId,
      client_secret: config.amazon.lwaClientSecret,
    })
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) throw new Error(`LWA token failed: ${res.status} ${await res.text()}`)
    const json = (await res.json()) as { access_token: string; expires_in: number }
    this.token = { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
    return this.token.accessToken
  }

  /** PUT a single keyword bid (v3). `bidMinor` is integer minor units → decimal. */
  async updateKeywordBid(profileId: string, keywordId: string, bidMinor: number): Promise<void> {
    if (config.worker.dryRun) return
    const accessToken = await this.accessToken()
    const res = await fetch(`${config.amazon.adsHost}/sp/keywords`, {
      method: 'PUT',
      headers: {
        'Amazon-Advertising-API-ClientId': config.amazon.lwaClientId,
        'Amazon-Advertising-API-Scope': profileId,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/vnd.spKeyword.v3+json',
        Accept: 'application/vnd.spKeyword.v3+json',
      },
      body: JSON.stringify({ keywords: [{ keywordId, bid: Math.round(bidMinor) / 100 }] }),
    })
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') ?? 0)
      throw new ThrottleError(ra > 0 ? ra * 1000 : 2_000)
    }
    if (!res.ok) throw new Error(`updateKeywordBid ${res.status}: ${await res.text()}`)
  }
}
